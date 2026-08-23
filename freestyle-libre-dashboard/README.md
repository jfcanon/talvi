# Leoncito's Glucose Dashboard

Static glucose-monitoring dashboard for a diabetic cat's Freestyle Libre 2
sensor. Reads the LibreLinkUp cloud API hourly, stores readings as JSON, and
serves a Chart.js dashboard from Cloudflare Pages.

```
[LibreLinkUp API] ──(home network, residential IP)──▶ [Lima VM fetcher (15 min)]
                                                            │ POST /api/ingest
                                                            ▼ Bearer INGEST_TOKEN
                      [leoncito-glucose Worker: KV store, GMT-3 merge] ──▶ [site/ (Chart.js)] ──▶ Cloudflare Pages
                                                                            ↓
                                                     app.ygdcbtmc4u.uk/leoncito
```

Since NID-403 the LibreLinkUp fetch runs on the **home network** (see
`home-fetcher/README.md`): libreview.io 403-blocks Cloudflare datacenter
egress IPs, so worker-side cron could never succeed. The Worker keeps the
store + dashboard backend role and accepts pushes on `POST /api/ingest`
(bearer-gated).

## Layout

```
freestyle-libre-dashboard/
├── scripts/
│   └── fetch_glucose.py       # Hourly fetch (pylibrelinkup)
├── data/
│   └── glucose.json           # Reading store (seed data committed; CI updates it)
├── site/
│   ├── index.html             # Static dashboard
│   ├── css/style.css
│   └── js/dashboard.js
├── wrangler.toml              # Cloudflare Pages config
├── requirements.txt
└── .env.local.example
```

The GitHub Actions workflow lives at `.github/workflows/leoncito.yml` (repo
root — that's the only place GitHub reads workflows from).

## Phase 1 — data pipeline

### Local test with sample data

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python scripts/fetch_glucose.py --mock --data data/glucose.json
```

`--mock` writes a deterministic 14-day sample series so the dashboard renders
without a sensor. `--data` overrides the output path.

### Live fetch

```bash
export LIBRELINK_EMAIL=... LIBRELINK_PASSWORD=...   # or use .env.local
python scripts/fetch_glucose.py
```

Exit codes:
- `0` — wrote data, **or** account has no connected patients (keeps existing
  data, logs a warning — link the sensor in LibreLinkUp to start feeding),
  **or** the connection exists but has no measurements yet (sensor not
  scanned since the follow was added — scan with the LibreLink app).
- `2` — missing credentials or API/auth failure (loud, so CI notices).
- `3` — ingest failure in `--ingest-url` mode: non-HTTPS URL, missing bearer
  token env var, or the Worker rejected the POST.

Credentials: use the **librelink app** pair (vault items `LIBRELINK_EMAIL_2` /
`LIBRELINK_PASSWORD_2`) for `LIBRELINK_EMAIL` / `LIBRELINK_PASSWORD` — that is
the account with the patient connection. The `LIBRELINK_EMAIL` /
`LIBRELINK_PASSWORD` vault items are the FreeStyle Libre app pair (no
LibreLinkUp connection).

The script dedups by timestamp, validates every reading (40–500 mg/dL, the
full LibreLinkUp measurable range — stricter would silently drop real hypo
readings), caps history at 120 days, and writes atomically.

## Phase 2 — dashboard

Preview locally:

```bash
mkdir -p site/data && cp data/glucose.json site/data/glucose.json
python3 -m http.server -d site 8000    # open http://localhost:8000
```

Views: 24h (raw), 7d / 30d (daily averages), all-time (weekly averages).
Cat zones: hypo <70 (red), low 70–90 (orange), target 90–270 (green), high
>270 (yellow). Chart.js + annotation plugin via CDN; auto-refreshes every 5
minutes; CSV export included.

## Phase 3 — deployment

### 1. Add GitHub Actions secrets to this repo

| Secret | Source |
| --- | --- |
| `LIBRELINK_EMAIL` / `LIBRELINK_PASSWORD` | LibreLinkUp account (in Bitwarden) |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens (Edit Pages) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → right sidebar |

### 2. Create the Pages project + routing (Terraform)

The Pages project and the `/leoncito` routing are **managed by IAC** per DSC:
`freestyle-libre-dashboard/main.tf` creates the `cloudflare_pages_project` and
a small proxy Worker (`scripts/leoncito_proxy.js`) on the
`app.ygdcbtmc4u.uk/leoncito(/*)` routes that strips the prefix and proxies to
the Pages project. A Worker is used instead of a transform-rule URL rewrite +
origin-rule host-header override — those need Business/WAF Advanced and a paid
plan respectively, and both 400'd on this zone's free plan.
`.github/workflows/terraform-leoncito.yml` plans on PR and applies on merge to
`main` (talvi convention — Terraform never runs locally). Merge the Terraform
first; assets deploy on top via Wrangler.

Only if you deploy before the Terraform merges, create the project manually:

```bash
npx wrangler@4 pages project create leoncito-dashboard --production-branch main
npx wrangler@4 pages deploy site --project-name leoncito-dashboard
```

### 3. Hourly schedule

`.github/workflows/leoncito.yml` runs the fetch + deploy **hourly** (at `:17`
each hour — kept clear of the top-of-hour burst other jobs favor) plus on
demand via **Actions → Leoncito → Run workflow**. Each run: fetches readings
→ commits `data/glucose.json` back (history accumulates) → deploys `site/` to
Pages. Data commits use the default `GITHUB_TOKEN`, which does not re-trigger
workflows, so no deploy loops.

## Current status

- Live since 2026-08-20: the hourly fetch populates `data/glucose.json` from
  the LibreLinkUp API (347+ readings as of writing) and deploys to
  app.ygdcbtmc4u.uk/leoncito.
- Routing fix (2026-08-20): the dashboard rendered all-dashes because bare
  `/leoncito` (no trailing slash) made the browser resolve relative asset URLs
  to `/css`, `/js`, `/data` — outside the prefix, onto the hub's `/*`
  fallback, which returns HTML and fails strict MIME checks. The proxy Worker
  now 302s `/leoncito` → `/leoncito/`, and `<base href="/leoncito/">` pins the
  resolution regardless.
- NID-403 (2026-08-21): libreview.io started 403-blocking Cloudflare
  datacenter egress IPs, killing the worker-side cron and `/api/fetch`.
  Fetching moved to a home-network Lima VM pushing `POST /api/ingest` every
  15 min — see `home-fetcher/README.md`. The Worker cron trigger was removed;
  `/api/fetch` remains as a manual diagnostic.

## Deviations from the original plan

- **Validation range 40–500 mg/dL**, not 80–400 — LibreLinkUp reports values
  down to 40 ("LO")/up to 500 ("HI"); dropping sub-80 readings would hide
  hypoglycaemic episodes.
- **`PyLibreLinkUp` class** (`authenticate()` / `get_patients()` /
  `latest()` / `graph()`), not the outdated `LibreLinkUpClient` snippet in
  the plan — v0.10.0's actual API.
- **Data is committed back to the repo** each run; the plan's workflow only
  uploaded an artifact, which would never accumulate 30d/all-time history.
- **Workflow at repo root** `.github/workflows/leoncito.yml` — GitHub only
  reads workflows from the root, not from a subdirectory.
- **Schedule disabled by default** until secrets are configured.
- **Cloudflare infra is Terraform-managed** (`main.tf` +
  `terraform-leoncito.yml`, applied on merge to main per talvi convention);
  the plan called for dashboard-side Origin Rules, but those (and the
  transform-rule URL rewrite) are paid-plan-only on this zone, so a proxy
  Worker on the `/leoncito` routes does the path rewrite + origin switch
  instead. Pages *assets* remain Wrangler-deployed (no Terraform resource for
  asset uploads).
- **Trailing-slash normalization** — bare `/leoncito` 302s to `/leoncito/`
  (same pattern as relay/chat/learn) plus `<base href="/leoncito/">` in the
  HTML, so relative asset URLs can never escape the subpath onto the hub.
