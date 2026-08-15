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

# Sentry provider — SENTRY_AUTH_TOKEN from env (GH Actions secret),
# SENTRY_ORG_ID from env (GH Actions variable). Neither appears in this file.
provider "sentry" {}

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

# Sentry organization ID — supplied as a GitHub Actions VARIABLE (not a secret):
# an org ID is an identifier, not a credential. The auth token is a secret.
variable "sentry_org_id" {
  type = string
}

# Sentry project slug for talvi-web (javascript-nextjs platform).
# Kept as a variable so the same pattern can be reused across stacks.
variable "sentry_project_slug_talvi_web" {
  type    = string
  default = "talvi-web"
}

# DEBUG_SENTRY — when set to "true", enables the /debug-sentry endpoint
# for synthetic error testing. Supplied as a GitHub Actions secret.
variable "debug_sentry" {
  type      = string
  default   = "false"
  sensitive = true
}

# Green release (2026-08-08): Clerk removed from the public Worker. Upload
# protection is Cloudflare Access on /api/upload (email-PIN, below). The Clerk
# variables/bindings lived here and were removed with the gate; the Clerk code
# is preserved in git history (branch clerk-custom-signin-clean) for the blue
# release on a separate host.
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

# Sentry organization data source — resolves the org by ID from the variable.
data "sentry_organization" "this" {
  id = var.sentry_org_id
}

# Sentry project for talvi-web (javascript-nextjs platform).
# DSN is computed and bound into the Worker as a secret_text binding.
resource "sentry_project" "talvi_web" {
  organization = data.sentry_organization.this.id
  name         = "talvi Web"
  slug         = var.sentry_project_slug_talvi_web
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

resource "cloudflare_workers_script" "talvi_web" {
  account_id         = var.cloudflare_account_id
  script_name        = "talvi-web"
  main_module        = "index.js"
  content            = file("${path.module}/dist/index.js") # built by esbuild in CI
  compatibility_date = "2026-07-30"

  # NO `migrations` BLOCK — deliberate, and it must stay that way. (PR2b)
  #
  # The ChatChannel namespace already exists. It was created by the PR1b apply
  # with `new_sqlite_classes = ["ChatChannel"]` (the free plan rejects
  # `new_classes` outright: "In order to use Durable Objects with a free plan,
  # you must create a namespace using a `new_sqlite_classes` migration"). That
  # migration is DONE. Re-declaring it is not a no-op — it is an error.
  #
  # Why the block cannot simply stay here: provider v5 marks `migrations`
  # WriteOnly, so Terraform stores it in neither state nor plan and re-sends it
  # on EVERY apply (cloudflare/terraform-provider-cloudflare#5701, #5898). The
  # Workers API is not idempotent for this field. The PR1b apply happened to
  # succeed only because the class had no live objects yet; once PR1's WebSocket
  # verification created some, the PR2 apply was refused outright:
  #
  #   PUT .../workers/scripts/talvi-web: 400 Bad Request
  #   code 10074: "Cannot apply new-sqlite-class migration to class
  #   'ChatChannel' that is already depended on by existing Durable Objects"
  #
  # That failure blocked the PR2 deploy entirely. Wrangler avoids this by
  # reading the deployed script's migration tag and sending migrations ONLY
  # when there are new ones; with no new migrations the field must be null.
  # Omitting the block is how Terraform sends null.
  #
  # So: the class is registered SQLite-backed (the namespace backend, not a
  # persistence we use — ChatChannel still writes ZERO bytes of state.storage,
  # everything in memory per D2/D3, so "channel dies when last member leaves"
  # is unchanged). It is never renamed or deleted.
  #
  # Add a `migrations` block again ONLY to declare a genuinely NEW class, and
  # remove it again in the very next PR once applied. If this script is ever
  # destroyed and recreated from scratch, the create-migration must be
  # temporarily restored — the namespace would not exist then.

  bindings = [
    { type = "d1", name = "DB", id = cloudflare_d1_database.talvi_meta.id },
    { type = "r2_bucket", name = "BUCKET", bucket_name = cloudflare_r2_bucket.talvi_drop.name },

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

    # Chat sidequest (PR1). One Durable Object per channel name; the Worker
    # routes /chat/<name>/ws to it. class_name must match the named export of
    # dist/index.js (src/chat/channel.js). Bounds are enforced in the object
    # itself, not here — the ratelimit bindings above are known-inert (RUNBOOK
    # §8) and are NOT relied on for chat abuse control (see D11/D12).
    {
      type       = "durable_object_namespace"
      name       = "CHAT_CHANNELS"
      class_name = "ChatChannel"
    },

    # Workers AI (markdown sidequest, PR1). Powers GET /:slug/md — the "as
    # markdown" image conversion. No secret, no egress; usage is metered in
    # neurons (10k/day free) and bounded by on-demand + R2 caching — see
    # plans/talvi-markdown-blueprint.md §2 and §7.
    {
      type = "ai"
      name = "AI"
    },
    {
      # Sentry DSN — computed by the sentry_project resource, bound as a secret
      # so it never appears in git or Terraform state. The Worker reads this via
      # env.SENTRY_DSN and initializes @sentry/cloudflare server-side only.
      type = "secret_text"
      name = "SENTRY_DSN"
      text = sentry_project.talvi_web.dsn
    },
    {
      # DEBUG_SENTRY — enables the /debug-sentry endpoint for synthetic error
      # testing. Only set to "true" in staging for verification; always "false"
      # in production. Supplied as a GitHub Actions secret.
      type = "secret_text"
      name = "DEBUG_SENTRY"
      text = var.debug_sentry
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

# Green release upload gate (2026-08-08). Cloudflare Access email-PIN protects
# the write endpoint only — /api/upload. /:slug and /:slug/d stay public
# (sharing is the product), and the "/" upload page renders for everyone (the
# POST is what requires the PIN). Mirrors ivlat's proven Access pattern.
# The onetimepin identity provider is ACCOUNT-scoped and already exists (ivlat
# created it, id d4addd78-c730-401d-bca3-02ec5e2fa5dd) — Cloudflare rejects a
# second one (code 12132). Reference the existing provider by its UUID.
data "cloudflare_zero_trust_access_identity_provider" "email_otp" {
  account_id           = var.cloudflare_account_id
  identity_provider_id = "d4addd78-c730-401d-bca3-02ec5e2fa5dd"
}

resource "cloudflare_zero_trust_access_application" "talvi_upload" {
  zone_id      = var.talvi_zone_id
  name         = "talvi — upload"
  domain       = "talvi.ygdcbtmc4u.uk/api/upload"
  type         = "self_hosted"
  allowed_idps = [data.cloudflare_zero_trust_access_identity_provider.email_otp.id]
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.talvi_owner_email.id
      precedence = 1
    },
  ]
}

resource "cloudflare_zero_trust_access_policy" "talvi_owner_email" {
  account_id = var.cloudflare_account_id
  name       = "Allow account owner"
  decision   = "allow"
  include = [{
    email = {
      email = "jangofett86@gmail.com"
    }
  }]
}

# Sentry alert rules for the talvi-web project.
resource "sentry_alert" "talvi_web_high_errors" {
  organization      = data.sentry_organization.this.id
  project           = sentry_project.talvi_web.slug
  name              = "High error rate — talvi-web"
  status            = "active"
  threshold_type    = 1 # event count
  query             = "project:" + sentry_project.talvi_web.slug
  time_window       = 60
  threshold_period  = 1
  alert_threshold   = 10
  resolve_threshold = 5
  owner = {
    type = "everyone"
  }
}

resource "sentry_alert" "talvi_web_cron_monitor" {
  organization   = data.sentry_organization.this.id
  project        = sentry_project.talvi_web.slug
  name           = "Cron monitor — 03:00 UTC purge"
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
