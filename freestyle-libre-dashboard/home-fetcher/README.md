# Leoncito home fetcher (NID-403)

The `leoncito-glucose` Cloudflare Worker can no longer fetch from
LibreLinkUp: `libreview.io` returns HTTP 403 (Cloudflare-classic WAF block)
to Cloudflare datacenter egress IPs in **both** regions, while the identical
request from a residential IP returns 200. So the fetch moved off the Worker
onto this home Mac:

```
[LibreLinkUp API] ──(residential IP, ~12h graph)──▶ [Lima VM: fetch_glucose.py]
                                                          │ POST /api/ingest
                                                          ▼ (Bearer INGEST_TOKEN)
                                    [leoncito-glucose Worker] ──▶ KV merge (120d cap, GMT-3)
                                                          │
                                     /api/glucose · /api/status · Pages site (unchanged)
```

## Decision — Lima VM, not Docker

Both Docker Desktop and a Lima VM (`agente`) are running on this Mac.
Reviewed on resource footprint, restart persistence, cron reliability, and
setup ease for `fetch_glucose.py` + Python deps:

| | Lima VM `agente` | Docker Desktop |
| --- | --- | --- |
| Footprint | vz (Apple Virtualization) VM already running for other work; zero marginal idle cost | its own Linux VM + UI/agent processes; plus a second provider (colima context) also installed — two competing daemons |
| Restart persistence | disk-backed VM; `limactl start` is idempotent and re-attaches state | container restart policies work, but Docker Desktop auto-updates restart the whole daemon mid-job |
| Cron reliability | job supervised by launchd on the host (VM is just an exec target); VM downtime self-heals via `limactl start` | needs host scheduler anyway (containerized cron adds nothing here) or a `--restart` sleep-loop hack |
| Setup ease | Ubuntu 24.04 LTS inside with python3 + venv; pure-Python deps (`pylibrelinkup`, `pydantic`) install cleanly on arm64 | fine too, but image build/pull maintenance for one script is overhead |

**Pick: the existing Lima VM** (`agente`; override any part via
`LEONCITO_LIMA_VM`). Docker remains documented as a viable fallback — nothing
here is Lima-specific beyond `limactl shell/cp`.

### Cadence decision

Every **15 minutes** (launchd `StartInterval 900`), not hourly:

- The sensor pushes a reading every 5 min; hourly sampling left up to 60-min
  staleness on a dashboard meant for hypo response. 15 min bounds it to ≤20.
- The LibreLinkUp graph window is ~12h ≈ 48 missed runs — the gap between
  successful pushes stays far inside the no-data-loss envelope even if the
  Mac/VM/network is down for most of a day.
- Volume is trivial (~96 polite API calls/day; community guidance for the
  unofficial LibreLinkUp API is ≥1 call/min).

Hourly would also work; change `StartInterval` to `3600` if preferred.

## Components

| File | Where it runs | Role |
| --- | --- | --- |
| `setup-lima.sh` | macOS host, once | verifies VM, bootstraps venv in the VM, stores BW master password in macOS Keychain, installs launchd agent |
| `host-run.sh` | macOS host, every run | unlocks Bitwarden → syncs code into VM → pipes secrets over stdin |
| `vm-job.sh` | inside Lima VM | validates stdin vars, runs `fetch_glucose.py --ingest-url` |

Secrets handling:

- Credentials live **only** in Bitwarden (`LIBRELINK_EMAIL_2` /
  `LIBRELINK_PASSWORD_2` — the pair with the patient connection — and the
  generated `Leoncito ingest token` item).
- Scheduled runs unlock the vault non-interactively from the macOS Keychain
  item `leoncito-bitwarden` (stored by setup step 3). Nothing lands in shell
  rc files or plain text.
- Secrets cross into the VM **via stdin**, never argv (invisible to `ps`),
  never written to disk on either side. The local `state/glucose.json`
  contains readings only.

## Setup

```bash
bash freestyle-libre-dashboard/home-fetcher/setup-lima.sh
```

Then add the ingest token to GitHub so Terraform binds it to the Worker:
repo **Settings → Secrets and variables → Actions → New repository secret**
· name `TF_VAR_INGEST_TOKEN` · value = the password field of the Bitwarden
item `Leoncito ingest token`. The next push to `main` applies the binding;
until then `/api/ingest` answers `503 ingest not configured` (fail-closed).

If the item doesn't exist yet: generate with `openssl rand -hex 32`, store as
a Bitwarden login item named `Leoncito ingest token` (password = token), and
put the same value in the GitHub secret.

## Verify

```bash
bash freestyle-libre-dashboard/home-fetcher/host-run.sh          # one manual run
tail -f ~/.leoncito-fetcher/host.log                             # host side
curl -s https://app.ygdcbtmc4u.uk/api/status                     # ok:true, source:"ingest"
curl -s https://app.ygdcbtmc4u.uk/api/glucose | tail -5          # fresh GMT-3 readings
```

Exit codes of `fetch_glucose.py` in ingest mode: `0` fetched+pushed,
`2` credentials/API failure, `3` ingest failure (HTTPS/token/HTTP error).

## Failure modes

- **Mac asleep/rebooted**: launchd re-fires at next wake/login; `RunAtLoad`
  covers login. The 12h upstream window makes multi-hour outages lossless.
- **Worker/KV down**: `fetch_glucose.py` exits 3, local `state/glucose.json`
  still holds the window; the next successful run's overlap backfills.
- **Token rotated**: update the Bitwarden item + GitHub secret; hosts read it
  fresh every run, Terraform rebinding happens on next apply.
- **Rollback**: `git revert` the PR removes routes/binding/handler; restore
  `cloudflare_workers_cron_trigger` + the Worker's scheduled handler to go
  back to worker-side fetching.
