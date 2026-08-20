# Leoncito's Glucose Dashboard

Static glucose-monitoring dashboard for a diabetic cat's Freestyle Libre 2
sensor. Reads the LibreLinkUp cloud API hourly, stores readings as JSON, and
serves a Chart.js dashboard from Cloudflare Pages.

```
[LibreLinkUp API] → [fetch_glucose.py (hourly CI)] → [data/glucose.json] → [site/ (Chart.js)] → [Cloudflare Pages]
                                                                                                  ↓
                                                                         app.ygdcbtmc4u.uk/leoncito
```

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
`freestyle-libre-dashboard/main.tf` creates the `cloudflare_pages_project`,
a path rewrite (`/leoncito/*` → `/`), and an origin rule routing the subpath
to the project. `.github/workflows/terraform-leoncito.yml` plans on PR and
applies on merge to `main` (talvi convention — Terraform never runs locally).
Merge the Terraform first; assets deploy on top via Wrangler.

Only if you deploy before the Terraform merges, create the project manually:

```bash
npx wrangler@4 pages project create leoncito-dashboard --production-branch main
npx wrangler@4 pages deploy site --project-name leoncito-dashboard
```

### 3. Enable the hourly schedule

`.github/workflows/leoncito.yml` ships with the schedule **commented out**.
After the secrets above exist, run it once via **Actions → Leoncito → Run
workflow**, then uncomment:

```yaml
schedule:
  - cron: '17 * * * *'
```

Each run: fetches readings → commits `data/glucose.json` back (history
accumulates) → deploys `site/` to Pages. Data commits use the default
`GITHUB_TOKEN`, which does not re-trigger workflows, so no deploy loops.

## Current status

- LibreLinkUp connection added (2026-08-20): the librelink app account
  (`LIBRELINK_EMAIL_2` / `LIBRELINK_PASSWORD_2`) now has a patient linked.
  The API reports **no glucose measurements yet** — data appears once the
  sensor is scanned with the LibreLink app (LibreLinkUp only receives data on
  scan). The fetch script handles this transient state gracefully (exit 0)
  and starts populating the store automatically on the next hourly run.
- Until the first scan lands, the dashboard runs on committed seed data
  (`data/glucose.json`).

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
  the plan called for dashboard-side Origin Rules. Pages *assets* remain
  Wrangler-deployed (no Terraform resource for asset uploads).
