# Blue release (talvi2.ygdcbtmc4u.uk) — Next.js on Cloudflare Workers via
# @opennextjs/cloudflare. Green (talvi.ygdcbtmc4u.uk, root main.tf) is
# untouched. See plans/talvi-blue-release-blueprint.md in sagwebapp.
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
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

# ---------------------------------------------------------------------------
# talvi2.ygdcbtmc4u.uk — DNS + routes.
#
# Green uses cloudflare_workers_custom_domain (whole hostname, one Worker).
# Blue splits one hostname across two Workers by path (blueprint L2/L3), which
# needs a proxied DNS record plus explicit routes; the most specific pattern
# wins. 192.0.2.1 is a documentation-address placeholder: proxied traffic is
# matched by the route patterns below and never actually resolved to it.
# ---------------------------------------------------------------------------

resource "cloudflare_dns_record" "talvi2" {
  zone_id = var.talvi_zone_id
  name    = "talvi2"
  content = "192.0.2.1"
  type    = "A"
  proxied = true
  ttl     = 1 # 1 = automatic; required by the provider and only valid when proxied
}

# ---------------------------------------------------------------------------
# talvi-blue — the Next.js app (OpenNext). PR 1 is the inert skeleton:
# placeholder page + /api/healthz, no bindings. PR 2 adds D1/R2/AI/ratelimit
# bindings; PR 3 adds the Clerk secret bindings.
# ---------------------------------------------------------------------------

# The OpenNext build emits a multi-file `.open-next/` directory; its entry
# worker.js imports sibling modules, so it is bundled to ONE file in CI
# (`wrangler deploy --dry-run --outdir=dist-worker`) before Terraform sees it.
# Content is referenced via content_file/content_sha256 (provider v5.7+), NOT
# content: the built script is ~5MB of minified JS — a single multiline string
# — and Terraform's plan renderer diffs string attributes with a Longest
# Common Subsequence that is O(lines²); rendering a changed 5MB script there
# OOM'd the plan step (fatal error: runtime: out of memory). content_file also
# keeps the script out of state.
resource "cloudflare_workers_script" "talvi_blue" {
  account_id          = var.cloudflare_account_id
  script_name         = "talvi-blue"
  main_module         = "index.js"
  content_file        = "${path.module}/dist-worker/worker.js"
  content_sha256      = filesha256("${path.module}/dist-worker/worker.js")
  compatibility_date  = "2026-08-07"
  compatibility_flags = ["nodejs_compat"]

  # PR 2: the write/read path bindings. Same shapes as green (main.tf), fresh
  # resources: D1 talvi-blue-meta, R2 talvi-blue-drop, and rate-limit
  # namespace ids 2101/2102 (green uses 2001/2002 — per-script identifiers,
  # chosen to stay visibly distinct from the relay's 1001/1002).
  bindings = [
    { type = "d1", name = "DB", id = cloudflare_d1_database.talvi_blue_meta.id },
    { type = "r2_bucket", name = "BUCKET", bucket_name = cloudflare_r2_bucket.talvi_blue_drop.name },

    # Workers-native rate limiting (green Step 6). Chosen over
    # cloudflare_rate_limit because that resource is zone-scoped. See the
    # KNOWN UNRESOLVED caveat in src/lib/rate.js — on green these never
    # fired; the code is correct against the documented API and inert.
    {
      type         = "ratelimit"
      name         = "RL_UPLOAD"
      namespace_id = "2101"
      simple = {
        limit  = 3
        period = 60
      }
    },
    {
      type         = "ratelimit"
      name         = "RL_READ"
      namespace_id = "2102"
      simple = {
        limit  = 60
        period = 60
      }
    },

    # Workers AI (markdown sidequest). Powers GET /:slug/md — the "as
    # markdown" image conversion. No secret, no egress; usage is metered in
    # neurons and bounded by on-demand + R2 caching.
    {
      type = "ai"
      name = "AI"
    },

    # Clerk auth (PR 3). CLERK_SECRET_KEY is a secret_text binding (never in
    # state); CLERK_PUBLISHABLE_KEY and CLERK_JWT_KEY are public by design. The
    # worker verifies the __session cookie locally via @clerk/backend using
    # jwtKey (no network per request, no clerk-js on any page except /sign-in,
    # no CSP change anywhere else).
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
  ]

  # OpenNext static assets (public/ + _next/static). The provider uploads the
  # directory and wires the ASSETS binding (provider v5.11+).
  assets = {
    directory = "${path.module}/.open-next/assets"
  }

  # NO `migrations` BLOCK — same rule as green. The OpenNext worker here has no
  # Durable Objects of its own; the chat DO lives in talvi-blue-chat (PR 4).
}

resource "cloudflare_workers_route" "talvi2_app" {
  zone_id = var.talvi_zone_id
  pattern = "talvi2.ygdcbtmc4u.uk/*"
  script  = cloudflare_workers_script.talvi_blue.script_name
}
