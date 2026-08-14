# Blue release — DECOMMISSIONED 2026-08-10. talvi2.ygdcbtmc4u.uk is legacy and
# deprecated; the serving surface (Worker + route + DNS) was removed when the
# Clerk login re-accommodated onto app.ygdcbtmc4u.uk (s7/talvi-blue-auth-
# handover.md). What remains here is the blue STORAGE (D1 talvi-blue-meta, R2
# talvi-blue-drop + lifecycle), kept deliberately — see the note at the bottom
# of this file. Green (talvi.ygdcbtmc4u.uk, root main.tf) is untouched.
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
    sentry = {
      source  = "jianyuan/sentry"
      version = "~> 0.15"
    }
  }

  # Separate state key from green, same R2 state bucket and credentials
  # (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from GH Actions secrets).
  backend "s3" {
    bucket = "talvi-tfstate"
    key    = "talvi/blue/terraform.tfstate"
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

provider "cloudflare" {}

# Sentry provider — SENTRY_AUTH_TOKEN from env (GH Actions secret),
# SENTRY_ORG_ID from env (GH Actions variable). Neither appears in this file.
provider "sentry" {}

variable "cloudflare_account_id" {
  type = string
}

variable "talvi_zone_id" {
  type = string
}

# Clerk auth (PR 3). Secret key is a secret_text binding so it never appears in
# state; the publishable key is public by design and ships as plain text. The
# JWT key is Clerk's public verification key (PEM) — also public, but stored in
# Bitwarden with its peers; passing it as jwtKey makes session verification
# networkless (green's Step 8 pattern).
variable "clerk_secret_key" {
  type = string
}

variable "clerk_publishable_key" {
  type = string
}

variable "clerk_jwt_key" {
  type = string
}

# Sentry organization ID — supplied as a GitHub Actions VARIABLE (not a secret):
# an org ID is an identifier, not a credential. The auth token is a secret.
variable "sentry_org_id" {
  type = string
}

# Sentry project slug for talvi-blue (javascript-nextjs platform).
# Chat worker inherits this project.
variable "sentry_project_slug_talvi_blue" {
  type    = string
  default = "talvi-blue"
}

# ---------------------------------------------------------------------------
# Blue storage — deliberately separate from green (blueprint L4). New names,
# so nothing is renamed or replaced.
# ---------------------------------------------------------------------------

resource "cloudflare_d1_database" "talvi_blue_meta" {
  account_id       = var.cloudflare_account_id
  name             = "talvi-blue-meta"
  read_replication = { mode = "disabled" }
}

resource "cloudflare_r2_bucket" "talvi_blue_drop" {
  account_id = var.cloudflare_account_id
  name       = "talvi-blue-drop"
  location   = "enam"
}

# Same lifecycle shape as green (RUNBOOK §4): one rule per retention tier,
# scoped by key prefix, declared in LEXICAL order (d1/, d30/, d7/, d90/) or
# the provider produces a perpetual "1 to change" plan. max_age is in SECONDS.
resource "cloudflare_r2_bucket_lifecycle" "talvi_blue_drop_expiry" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.talvi_blue_drop.name
  rules = [
    {
      id         = "expire-d1"
      enabled    = true
      conditions = { prefix = "d1/" }
      delete_objects_transition = {
        condition = { max_age = 1 * 24 * 60 * 60, type = "Age" } # 86400
      }
    },
    {
      id         = "expire-d30"
      enabled    = true
      conditions = { prefix = "d30/" }
      delete_objects_transition = {
        condition = { max_age = 30 * 24 * 60 * 60, type = "Age" } # 2592000
      }
    },
    {
      id         = "expire-d7"
      enabled    = true
      conditions = { prefix = "d7/" }
      delete_objects_transition = {
        condition = { max_age = 7 * 24 * 60 * 60, type = "Age" } # 604800
      }
    },
    {
      id         = "expire-d90"
      enabled    = true
      conditions = { prefix = "d90/" }
      delete_objects_transition = {
        condition = { max_age = 90 * 24 * 60 * 60, type = "Age" } # 7776000 — hard cap
      }
    },
  ]
}

# Sentry organization data source — resolves the org by ID from the variable.
data "sentry_organization" "this" {
  id = var.sentry_org_id
}

# Sentry project for talvi-blue (javascript-nextjs platform).
# Chat worker inherits this project.
resource "sentry_project" "talvi_blue" {
  organization = data.sentry_organization.this.id
  name         = "talvi Blue"
  slug         = var.sentry_project_slug_talvi_blue
  platform     = "javascript-nextjs"

  # Data hygiene: scrub sensitive data at ingest.
  data_collection = {
    security = {
      default_pii = false
    }
    pii = {
      enabled = false
    }
  }

  # Inbound data filter to drop events with sensitive headers/cookies.
  inbound_data_filter = [
    "password",
    "secret",
    "authorization",
    "cookie",
    "x-api-key",
    "x-csrf-token",
  ]
}

# Sentry alert rules for the talvi-blue project.
resource "sentry_alert" "talvi_blue_high_errors" {
  organization = data.sentry_organization.this.id
  project      = sentry_project.talvi_blue.slug
  name         = "High error rate — talvi-blue"
  status       = "active"
  threshold_type = 1 # event count
  query        = "project:" + sentry_project.talvi_blue.slug
  time_window  = 60
  threshold_period = 1
  alert_threshold = 10
  resolve_threshold = 5
  owner = {
    type = "everyone"
  }
}

resource "sentry_alert" "talvi_blue_cron_monitor" {
  organization = data.sentry_organization.this.id
  project      = sentry_project.talvi_blue.slug
  name         = "Cron monitor — 03:00 UTC purge"
  status       = "active"
  threshold_type = 2 # cron monitor
  cron_monitor_config = {
    schedule = "0 3 * * *"
    timezone = "UTC"
    checkin_margin = 10
    max_runtime = 300
  }
  owner = {
    type = "everyone"
  }
}


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# talvi2.ygdcbtmc4u.uk — DECOMMISSIONED 2026-08-10.
#
# The Clerk login was re-accommodated onto app.ygdcbtmc4u.uk (the relay's
# in-worker session gate, s7/talvi-blue-auth-handover.md). talvi2 is legacy and
# deprecated; the serving surface is removed: the talvi-blue Worker, its route,
# and the talvi2 DNS record are gone, so the host stops resolving and no worker
# answers it. Links to talvi2.ygdcbtmc4u.uk break by design (blueprint A8).
#
# The blue STORAGE below (D1 talvi-blue-meta, R2 talvi-blue-drop + lifecycle)
# is deliberately KEPT: destroying storage destroys data (CLAUDE.md), and no
# decision has been made on the blue drops. Nothing references it anymore, so
# it is inert. If it is ever wanted back, the storage is ready; the serving
# surface would need to be recreated.
# ---------------------------------------------------------------------------
# (The worker script, its route, and the talvi2 DNS record were removed.)

