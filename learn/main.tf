# talvi learn — the Tribunal Learn course, mounted at app.ygdcbtmc4u.uk/learn.
#
# PR4 is the D1 data layer + gamification API step (NID-99): the D1 binding
# lands here, and — because PR3 (Clerk gate, NID-98) had not merged when this
# PR opened — the Clerk bindings are carried inside, documented as an unmerged
# dependency (the learn-6-ui precedent, #149). The worker serves /learn/healthz
# plus the gated gamification APIs (/learn/api/state, /learn/api/complete,
# /learn/api/curriculum). Full architecture: plans/talvi-learn-blueprint.md.
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

  # Remote state on R2 (S3-compatible). Own key under the same talvi-tfstate
  # bucket and credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from GH
  # Actions secrets). Separate from every sibling key (talvi/terraform.tfstate,
  # talvi/blue/…, talvi/hub/…, talvi/relay/…, talvi/chat/…, talvi/3d/…),
  # deliberately. Blueprint D.5 records the factual discovery that decision 1's
  # "own tfstate bucket key (talvi-learn-tfstate)" is satisfied by the key
  # talvi/learn/terraform.tfstate in that same shared bucket — the isolation
  # property is identical and it matches every sibling app.
  backend "s3" {
    bucket = "talvi-tfstate"
    key    = "talvi/learn/terraform.tfstate"
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

# Sentry provider — SENTRY_AUTH_TOKEN from env (GH Actions secret),
# SENTRY_ORG_ID from env (GH Actions variable). Neither appears in this file.
provider "sentry" {}

variable "cloudflare_account_id" {
  type = string
}

# Sentry organization ID — supplied as a GitHub Actions VARIABLE (not a secret):
# an org ID is an identifier, not a credential. The auth token is a secret.
variable "sentry_org_id" {
  type = string
}

# Sentry project slug for talvi-learn (javascript-nextjs platform).
variable "sentry_project_slug_talvi_learn" {
  type    = string
  default = "talvi-learn"
}

# Zone ID for ygdcbtmc4u.uk — a GitHub Actions VARIABLE, not a secret.
variable "talvi_zone_id" {
  type = string
}

# Clerk bindings (carried PR3) — the in-worker session gate verifies the
# host-wide __session cookie with @clerk/backend + jwtKey (networkless). ALL
# THREE keys are required; authenticateRequest throws without the publishable
# key.
variable "clerk_secret_key" {
  type = string
}

variable "clerk_publishable_key" {
  type = string
}

variable "clerk_jwt_key" {
  type = string
}

# Learn's own D1 database (decision 3) — separate from talvi-meta and
# talvi-blue-meta (release isolation). Created in PR2 as the resource; the
# worker binding lands here with the data layer. The CREATE TABLE IF NOT
# EXISTS DDL ships in learn/src/lib/store.js (converged PR4 schema).
resource "cloudflare_d1_database" "talvi_learn_meta" {
  account_id       = var.cloudflare_account_id
  name             = "talvi-learn-meta"
  read_replication = { mode = "disabled" }
}

# Sentry organization data source — resolves the org by ID from the variable.
data "sentry_organization" "this" {
  id = var.sentry_org_id
}

# Sentry project for talvi-learn (javascript-nextjs platform).
resource "sentry_project" "talvi_learn" {
  organization = data.sentry_organization.this.id
  name         = "talvi Learn"
  slug         = var.sentry_project_slug_talvi_learn
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

# Sentry alert rules for the talvi-learn project.
resource "sentry_alert" "talvi_learn_high_errors" {
  organization      = data.sentry_organization.this.id
  project           = sentry_project.talvi_learn.slug
  name              = "High error rate — talvi-learn"
  status            = "active"
  threshold_type    = 1 # event count
  query             = "project:" + sentry_project.talvi_learn.slug
  time_window       = 60
  threshold_period  = 1
  alert_threshold   = 10
  resolve_threshold = 5
  owner = {
    type = "everyone"
  }
}

# Sentry cron monitor for learn's scheduled tasks.
resource "sentry_alert" "talvi_learn_cron_monitor" {
  organization   = data.sentry_organization.this.id
  project        = sentry_project.talvi_learn.slug
  name           = "Cron monitor — learn scheduled tasks"
  status         = "active"
  threshold_type = 2 # cron monitor
  cron_monitor_config = {
    schedule       = "0 3 * * *"
    timezone       = "UTC"
    checkin_margin = 10
    max_runtime    = 300
  }
  owner = {
    type = "everyone"
  }
}

# The learn Worker — the PR4 worker. nodejs_compat is required by
# @clerk/backend (the networkless JWT verifier), same as green/blue/relay/hub.
# NO `migrations` block — no Durable Objects, and a stale one would be
# re-sent on every apply (hub/relay record, code 10074).
resource "cloudflare_workers_script" "talvi_learn" {
  account_id          = var.cloudflare_account_id
  script_name         = "talvi-learn"
  main_module         = "index.js"
  content             = file("${path.module}/dist/index.js") # built by esbuild in CI
  compatibility_date  = "2026-08-14"
  compatibility_flags = ["nodejs_compat"]

  bindings = [
    # The D1 data layer — xp_events append-only ledger + derived
    # lesson_progress/player_state (decision 3, converged PR4 schema).
    { type = "d1", name = "DB", id = cloudflare_d1_database.talvi_learn_meta.id },

    # Clerk auth (carried PR3) — learn verifies the host-wide __session cookie
    # in-worker (decision 2 / B.2). CLERK_SECRET_KEY is a secret_text binding
    # (never in state); the publishable and JWT keys are public by design.
    {
      type = "secret_text"
      name = "CLERK_SECRET_KEY"
      text = var.clerk_secret_key
    },
    {
      type = "plain_text"
      name = "CLERK_PUBLISHABLE_KEY"
      text = var.clerk_publishable_key
    },
    {
      type = "plain_text"
      name = "CLERK_JWT_KEY"
      text = var.clerk_jwt_key
    },
    {
      # Sentry DSN — computed by the sentry_project resource, bound as a secret
      # so it never appears in git or Terraform state. The Worker reads this via
      # env.SENTRY_DSN and initializes @sentry/cloudflare server-side only.
      type = "secret_text"
      name = "SENTRY_DSN"
      text = sentry_project.talvi_learn.dsn
    },
  ]
}

# Routes: app.ygdcbtmc4u.uk/learn (exact) and /learn/*. The hub owns the `/*`
# fallback; these more-specific patterns win (blueprint B.1). The exact /learn
# route matters: the hub blade will link to /learn (no trailing slash), and a
# `learn/*` wildcard alone would 404 it — the same lesson relay/chat encoded in
# their root routes.
resource "cloudflare_workers_route" "learn" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/learn/*"
  script  = cloudflare_workers_script.talvi_learn.script_name
}

resource "cloudflare_workers_route" "learn_root" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/learn"
  script  = cloudflare_workers_script.talvi_learn.script_name
}
