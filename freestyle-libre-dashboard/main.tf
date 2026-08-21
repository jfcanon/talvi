# Leoncito dashboard — Cloudflare Pages project + routing for the /leoncito
# subpath on app.ygdcbtmc4u.uk. Managed by IAC per DSC; the actual site
# assets are still pushed with Wrangler (Pages asset deployment is
# Wrangler-only — no provider resource exists for it), see leoncito.yml.
#
# Routing: the apex host app.ygdcbtmc4u.uk is served by the talvi hub Worker
# (its `/*` fallback). /leoncito is served by a small proxy Worker on a
# more-specific route (same pattern as relay/chat/learn). Why a Worker and
# not rulesets: the transform-rule path rewrite needs regex_replace
# (Business / WAF Advanced only) and the origin-rule HostHeader override
# needs a paid plan — both 400'd on this zone. The Worker strips the
# /leoncito prefix and proxies to the Pages project's *.pages.dev host, no
# paid features involved.
#
# Glucose Worker: separate Worker that fetches from LibreLinkUp on cron,
# stores in KV, serves data via /api/glucose endpoint.

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }

  # Remote state on R2 — own key under the shared talvi-tfstate bucket,
  # mirroring every sibling app (talvi/, talvi/learn/, talvi/chat/...).
  backend "s3" {
    bucket = "talvi-tfstate"
    key    = "talvi/leoncito/terraform.tfstate"
    region = "auto"
    endpoints = {
      s3 = "https://a5164131e929a177af583d60f4c6dc47.r2.cloudflarestorage.com"
    }
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

# Token read from CLOUDFLARE_API_TOKEN automatically — never set here.
provider "cloudflare" {}

variable "cloudflare_account_id" {
  type = string
}

# Zone ID for ygdcbtmc4u.uk — a GitHub Actions VARIABLE, not a secret.
variable "talvi_zone_id" {
  type = string
}

# LibreLinkUp credentials — GitHub Actions SECRETS, never logged or stored in state
variable "librelink_email" {
  type      = string
  sensitive = true
}

variable "librelink_password" {
  type      = string
  sensitive = true
}

# KV namespace for glucose data
resource "cloudflare_workers_kv_namespace" "glucose_data" {
  account_id = var.cloudflare_account_id
  title      = "leoncito-glucose-data"
}

# Seed the KV store with the historical data/glucose.json so the dashboard has
# ~2 weeks of history immediately after first apply, before the next cron run
# accumulates. `ignore_changes = [value]` hands ownership to the Worker after
# seed — otherwise every apply would revert the key to this repo file and fight
# the runtime writes (perpetual plan drift + data loss).
resource "cloudflare_workers_kv" "glucose_seed" {
  account_id   = var.cloudflare_account_id
  namespace_id = cloudflare_workers_kv_namespace.glucose_data.id
  key_name     = "glucose.json"
  value        = file("${path.module}/data/glucose.json")
  lifecycle {
    ignore_changes = [value]
  }
}

# The Pages project itself. Assets are deployed by leoncito.yml via
# `wrangler pages deploy site --project-name leoncito-dashboard`.
resource "cloudflare_pages_project" "leoncito" {
  account_id        = var.cloudflare_account_id
  name              = "leoncito-dashboard"
  production_branch = "main"
}

# The proxy Worker — strips the /leoncito prefix and proxies to the Pages
# project. A plain ES module with no deps (unlike relay/chat/learn, which
# esbuild to dist/index.js), so the repo file is uploaded verbatim.
resource "cloudflare_workers_script" "leoncito_proxy" {
  account_id         = var.cloudflare_account_id
  script_name        = "leoncito-proxy"
  main_module        = "leoncito_proxy.js"
  content            = file("${path.module}/scripts/leoncito_proxy.js")
  compatibility_date = "2026-08-20"
}

# Glucose Worker — fetches LibreLinkUp data on cron, stores in KV, serves via HTTP
resource "cloudflare_workers_script" "leoncito_glucose" {
  account_id         = var.cloudflare_account_id
  script_name        = "leoncito-glucose"
  main_module        = "worker.js"
  content            = file("${path.module}/worker.js")
  compatibility_date = "2026-08-20"

  bindings = [
    {
      name        = "LEONCITO_DATA"
      type        = "kv_namespace"
      namespace_id = cloudflare_workers_kv_namespace.glucose_data.id
    },
    {
      type = "secret_text"
      name = "LIBRELINK_EMAIL"
      text = var.librelink_email
    },
    {
      type = "secret_text"
      name = "LIBRELINK_PASSWORD"
      text = var.librelink_password
    },
  ]
}

# Cron trigger for glucose Worker (hourly at :17)
resource "cloudflare_workers_cron_trigger" "glucose_cron" {
  account_id    = var.cloudflare_account_id
  script_name   = cloudflare_workers_script.leoncito_glucose.script_name
  schedules     = [{ cron = "17 * * * *" }]
}

# Routes: app.ygdcbtmc4u.uk/leoncito (exact) and /leoncito/*. The hub owns
# the `/*` fallback; these more-specific patterns win (same pattern as
# relay/chat/learn). The exact route matters — a wildcard alone would 404 the
# bare /leoncito.
resource "cloudflare_workers_route" "leoncito" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/leoncito/*"
  script  = cloudflare_workers_script.leoncito_proxy.script_name
}

resource "cloudflare_workers_route" "leoncito_root" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/leoncito"
  script  = cloudflare_workers_script.leoncito_proxy.script_name
}

# Glucose Worker route for API endpoint - exact match for /api/glucose
resource "cloudflare_workers_route" "glucose_api_exact" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/api/glucose"
  script  = cloudflare_workers_script.leoncito_glucose.script_name
}

# Glucose Worker route for API endpoint - wildcard for /api/glucose/*
resource "cloudflare_workers_route" "glucose_api_wildcard" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/api/glucose/*"
  script  = cloudflare_workers_script.leoncito_glucose.script_name
}

# Glucose Worker route for fetch-status observability endpoint
resource "cloudflare_workers_route" "glucose_api_status" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/api/status"
  script  = cloudflare_workers_script.leoncito_glucose.script_name
}

# Manual-fetch trigger — forces a LibreLinkUp sync outside the cron. Lets the
# owner (or a debugger) refresh data on demand and see the exact auth error.
resource "cloudflare_workers_route" "glucose_api_fetch" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/api/fetch"
  script  = cloudflare_workers_script.leoncito_glucose.script_name
}

