terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }

  # Remote state on R2 (S3-compatible). Credentials come from
  # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (GH Actions secrets, sourced
  # from Bitwarden) — never referenced here; the s3 backend reads them.
  # Separate bucket from the relay project's state, deliberately.
  backend "s3" {
    bucket = "talvi-tfstate"
    key    = "talvi/terraform.tfstate"
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

# Zone ID for ygdcbtmc4u.uk — the same zone the relay uses. Supplied as a
# GitHub Actions VARIABLE, not a secret: a zone id is an identifier, not a
# credential, and treating it as a secret would only make it harder to read in
# a plan diff where it is genuinely useful.
variable "talvi_zone_id" {
  type = string
}

variable "clerk_secret_key" {
  type      = string
  sensitive = true
}

variable "clerk_publishable_key" {
  type      = string
  sensitive = true
}

variable "clerk_jwt_key" {
  type      = string
  sensitive = true
}

resource "cloudflare_d1_database" "talvi_meta" {
  account_id       = var.cloudflare_account_id
  name             = "talvi-meta"
  read_replication = { mode = "disabled" }
}

resource "cloudflare_r2_bucket" "talvi_drop" {
  account_id = var.cloudflare_account_id
  name       = "talvi-drop"
  location   = "enam"
}

# Retention is infrastructure, not application code — it keeps working if
# the Worker is deleted or the project is abandoned. One rule per tier,
# scoped by key prefix (blueprint B.4).
#
# max_age is in SECONDS. This is confirmed, not assumed — the relay project
# established it the hard way. Do not "fix" these to day counts.
resource "cloudflare_r2_bucket_lifecycle" "talvi_drop_expiry" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.talvi_drop.name
  # Declared in the order the Cloudflare provider canonicalises to: LEXICAL by
  # prefix (d1/, d30/, d7/, d90/), NOT numeric (d1/, d7/, d30/, d90/). The
  # provider reads the rules back sorted lexically, so declaring them in numeric
  # order produces a perpetual "1 to change" plan that just swaps d7 and d30 on
  # every run — caught by Step 2's determinism check. Keep this lexical order.
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

resource "cloudflare_workers_script" "talvi_web" {
  account_id         = var.cloudflare_account_id
  script_name        = "talvi-web"
  main_module        = "index.js"
  content            = file("${path.module}/dist/index.js") # built by esbuild in CI
  compatibility_date = "2026-07-30"

  bindings = [
    { type = "d1", name = "DB", id = cloudflare_d1_database.talvi_meta.id },
    { type = "r2_bucket", name = "BUCKET", bucket_name = cloudflare_r2_bucket.talvi_drop.name },

    # Clerk auth secrets (Step 8 — auth gates / and /api/upload).
    # Distributed to the Worker so authenticateRequest() can verify __session
    # cookies locally without a network round trip.
    { type = "secret_text", name = "CLERK_SECRET_KEY", text = var.clerk_secret_key },
    { type = "secret_text", name = "CLERK_PUBLISHABLE_KEY", text = var.clerk_publishable_key },
    { type = "secret_text", name = "CLERK_JWT_KEY", text = var.clerk_jwt_key },

    # Workers-native rate limiting (Step 6). Chosen over cloudflare_rate_limit
    # because that resource is zone-scoped, and this account controls no zone
    # for *.workers.dev. These bindings work on workers.dev directly — the same
    # mechanism the relay already runs in production.
    #
    # `period` accepts only 10 or 60. namespace_id values are per-script;
    # 2001/2002 are chosen to be visibly distinct from the relay's 1001/1002
    # when the two configs are read side by side.
    {
      # Uploads per IP. Deliberately tight: this endpoint is unauthenticated
      # and writes to storage. 3/min is generous for a human and hostile to a
      # script.
      type         = "ratelimit"
      name         = "RL_UPLOAD"
      namespace_id = "2001"
      simple = {
        limit  = 3
        period = 60
      }
    },
    {
      # Reads per IP — covers view pages, downloads, and 404 probing. The last
      # of those is why this exists: without it, a slug's 96-bit keyspace is
      # still only as strong as the rate at which someone may guess.
      type         = "ratelimit"
      name         = "RL_READ"
      namespace_id = "2002"
      simple = {
        limit  = 60
        period = 60
      }
    },
  ]
}

# A fresh script's workers.dev route defaults to disabled — encoded from the
# relay project's first deploy. The account-level workers.dev subdomain
# itself (ygdcbtmc4u) already exists and needs no action here.
# Nightly purge (Step 7). R2 lifecycle rules delete the OBJECTS; nothing
# deleted the D1 ROWS, so `drops` grew forever and the daily-budget query —
# which sums size_bytes across the last 24h on every single upload — got
# slower every day. 03:00 UTC is chosen for being nobody's peak.
resource "cloudflare_workers_cron_trigger" "talvi_purge" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.talvi_web.script_name
  # `schedules`, NOT `body`. The blueprint's Step 7 snippet says `body` and
  # marks it "confirmed"; it is wrong for cloudflare provider v5, which
  # rejected it outright: 'An argument named "body" is not expected here' plus
  # 'The argument "schedules" is required'. Corrected here, and the blueprint
  # has been annotated so the next reader does not re-derive this.
  schedules = [
    { cron = "0 3 * * *" }
  ]
}

# Custom domain. WHY, since workers.dev worked fine: *.workers.dev is a shared
# free-tier namespace with a lot of abuse in it, so corporate proxies, mail
# filters and some DNS blocklists treat those links with suspicion. For an app
# whose entire purpose is sending someone a link, a silently blocked link is a
# total product failure — this is the one downside that actually bites.
#
# Same shape the relay already proves in production
# (cloudflare_workers_custom_domain, which creates its own DNS record — no
# separate cloudflare_dns_record needed).
#
# The workers.dev subdomain below stays ENABLED and untouched. Every link
# already shared points at it, and turning it off would break every one of
# them. Two hostnames serve the same Worker; new links use whichever host the
# uploader visited.
resource "cloudflare_workers_custom_domain" "talvi_web_custom_domain" {
  account_id = var.cloudflare_account_id
  zone_id    = var.talvi_zone_id
  zone_name  = "ygdcbtmc4u.uk"
  hostname   = "talvi.ygdcbtmc4u.uk"
  service    = cloudflare_workers_script.talvi_web.script_name
}

resource "cloudflare_workers_script_subdomain" "talvi_web_subdomain" {
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.talvi_web.script_name
  enabled          = true
  previews_enabled = false
}
