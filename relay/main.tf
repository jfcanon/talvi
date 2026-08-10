# talvi relay — the file drop, mounted at app.ygdcbtmc4u.uk/relay.
#
# Forks green's worker (plans/talvi-hub-blueprint.md, Workstream B): the
# file-drop routes with chat removed (chat stays on green until Workstream C).
# The relay SHARES green's D1 (talvi-meta) and R2 (talvi-drop) so existing
# drops keep working — new uploads and old links both resolve. The upload gate
# is a Clerk session verified in-worker (s7/talvi-blue-auth-handover.md); reads
# stay public. The Cloudflare Access application that used to gate the upload
# POST was removed when the Clerk gate landed — same swap the blue release made,
# one layer instead of two.
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }

  # Remote state on R2 (S3-compatible). Own key under the same talvi-tfstate
  # bucket and credentials. Separate from green/hub/blue keys, deliberately.
  backend "s3" {
    bucket = "talvi-tfstate"
    key    = "talvi/relay/terraform.tfstate"
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

variable "cloudflare_account_id" {
  type = string
}

variable "talvi_zone_id" {
  type = string
}

variable "clerk_secret_key" {
  type = string
}

variable "clerk_jwt_key" {
  type = string
}

# ---------------------------------------------------------------------------
# Shared storage — GREEN'S existing D1 and R2, looked up by name. NOT new
# resources. The relay must serve the same drops green serves, so it binds to
# the same talvi-meta / talvi-drop that root main.tf created. Renaming or
# replacing them would destroy data (CLAUDE.md).
# ---------------------------------------------------------------------------
data "cloudflare_d1_database" "talvi_meta" {
  account_id = var.cloudflare_account_id
  filter = {
    name = "talvi-meta"
  }
}

data "cloudflare_r2_bucket" "talvi_drop" {
  account_id  = var.cloudflare_account_id
  bucket_name = "talvi-drop"
}

# Workers AI (markdown sidequest) — same binding shape as green's.
resource "cloudflare_workers_script" "talvi_relay" {
  account_id         = var.cloudflare_account_id
  script_name        = "talvi-relay"
  main_module        = "index.js"
  content            = file("${path.module}/dist/index.js") # built by esbuild in CI
  compatibility_date = "2026-08-10"
  # nodejs_compat: @clerk/backend (the networkless JWT verifier) is built for
  # the Workers runtime but expects node-compat primitives, same as green/blue.
  compatibility_flags = ["nodejs_compat"]

  bindings = [
    { type = "d1", name = "DB", id = data.cloudflare_d1_database.talvi_meta.id },
    { type = "r2_bucket", name = "BUCKET", bucket_name = data.cloudflare_r2_bucket.talvi_drop.name },

    # Workers-native rate limiting — same shapes/ids as green (2001/2002).
    {
      type         = "ratelimit"
      name         = "RL_UPLOAD"
      namespace_id = "2001"
      simple = {
        limit  = 3
        period = 60
      }
    },
    {
      type         = "ratelimit"
      name         = "RL_READ"
      namespace_id = "2002"
      simple = {
        limit  = 60
        period = 60
      }
    },

    # Workers AI — powers GET /relay/:slug/md (the "as markdown" conversion).
    {
      type = "ai"
      name = "AI"
    },

    # Clerk auth (port of blue's PR 3 bindings, minus the publishable key —
    # the relay no longer serves clerk-js pages; sign-in lives at the app root).
    # CLERK_SECRET_KEY is a secret_text binding (never in state);
    # CLERK_JWT_KEY is public by design. The worker verifies the __session
    # cookie locally via @clerk/backend using jwtKey — no network per request.
    {
      type = "secret_text"
      name = "CLERK_SECRET_KEY"
      text = var.clerk_secret_key
    },
    {
      type = "plain_text"
      name = "CLERK_JWT_KEY"
      text = var.clerk_jwt_key
    },
  ]

  # NO `migrations` block — the relay has no Durable Objects (chat is not here).
}

# Routes: app.ygdcbtmc4u.uk/relay (exact) and /relay/* (everything under it).
# The hub owns the `/*` fallback; these more-specific patterns win. The exact
# /relay route matters: the blade links to /relay (no trailing slash), and a
# `relay/*` wildcard alone would 404 it.
resource "cloudflare_workers_route" "relay" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/relay/*"
  script  = cloudflare_workers_script.talvi_relay.script_name
}

resource "cloudflare_workers_route" "relay_root" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/relay"
  script  = cloudflare_workers_script.talvi_relay.script_name
}
