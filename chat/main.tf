# talvi chat — mounted at app.ygdcbtmc4u.uk/chat.
#
# Forks green's chat (plans/talvi-hub-blueprint.md, Workstream C) as a
# dedicated plain Worker. The preservation contract (s6 handover §7) is why
# this is its own Worker and not a Next.js route: /chat/<name>/ws must be a
# plain WebSocket route, and chat reads no session. Shares green's D1/R2 for
# the nightly purge (blueprint L8).
#
# ⚠ MIGRATIONS DANCE COMPLETE: the ChatChannel namespace was created by PR C1
# (new_sqlite_classes = ["ChatChannel"]) and this PR (C2) REMOVED the argument.
# It must never be re-declared while the class has live objects (code 10074 —
# see the note on the worker resource below). The two-PR dance is done.
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }

  # Remote state on R2 (S3-compatible). Own key under the same talvi-tfstate
  # bucket and credentials. Separate from green/hub/relay/blue keys.
  backend "s3" {
    bucket = "talvi-tfstate"
    key    = "talvi/chat/terraform.tfstate"
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

# ---------------------------------------------------------------------------
# Shared storage — GREEN'S existing D1/R2, looked up by name (the purge deletes
# expired drop rows + objects, same as green's). Never renamed (CLAUDE.md).
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

resource "cloudflare_workers_script" "talvi_chat" {
  account_id         = var.cloudflare_account_id
  script_name        = "talvi-chat"
  main_module        = "index.js"
  content            = file("${path.module}/dist/index.js") # built by esbuild in CI
  compatibility_date = "2026-08-10"

  bindings = [
    # The ChatChannel Durable Object. class_name matches the named export of
    # dist/index.js (src/chat/channel.js). SQLite-backed namespace, required by
    # the free plan — the migrations block below creates it on the C1 apply.
    {
      type       = "durable_object_namespace"
      name       = "CHAT_CHANNELS"
      class_name = "ChatChannel"
    },
    # D1 + R2 for the nightly purge (blueprint L8).
    { type = "d1", name = "DB", id = data.cloudflare_d1_database.talvi_meta.id },
    { type = "r2_bucket", name = "BUCKET", bucket_name = data.cloudflare_r2_bucket.talvi_drop.name },
  ]

  # NO `migrations` ARGUMENT — deliberate, and it must stay that way. PR C1
  # shipped `new_sqlite_classes = ["ChatChannel"]` to create the SQLite-backed
  # namespace; the C1 apply ran and the class now has live objects. Provider
  # v5 marks `migrations` WriteOnly, so Terraform re-sends it on EVERY apply and
  # Cloudflare rejects it once the class is depended on by live Durable Objects
  # (code 10074 — the same trap that cost green hours; fixed there in PR #51).
  # Omitting the argument is how Terraform sends null. Add it again ONLY to
  # declare a genuinely NEW class, and remove it in the very next PR.
}

# Nightly purge — the chat worker owns it (plain Worker, scheduled handler).
# 03:00 UTC is chosen for being nobody's peak. Same shape as green.
resource "cloudflare_workers_cron_trigger" "talvi_chat_purge" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.talvi_chat.script_name
  # `schedules`, NOT `body` (provider v5 rejects body).
  schedules = [
    { cron = "0 3 * * *" }
  ]
}

# Routes: app.ygdcbtmc4u.uk/chat (exact) and /chat/*. The hub owns the `/*`
# fallback; these more-specific patterns win.
resource "cloudflare_workers_route" "chat" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/chat/*"
  script  = cloudflare_workers_script.talvi_chat.script_name
}

resource "cloudflare_workers_route" "chat_root" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/chat"
  script  = cloudflare_workers_script.talvi_chat.script_name
}
