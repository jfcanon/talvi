# talvi chat — mounted at app.ygdcbtmc4u.uk/chat.
#
# Forks green's chat (plans/talvi-hub-blueprint.md, Workstream C) as a
# dedicated plain Worker. The preservation contract (s6 handover §7) is why
# this is its own Worker and not a Next.js route: /chat/<name>/ws must be a
# plain WebSocket route, and chat reads no session. Shares green's D1/R2 for
# the nightly purge (blueprint L8).
#
# ⚠ THE TWO-PR MIGRATIONS DANCE — read before touching this file:
# The ChatChannel namespace on THIS worker is a NEW namespace (the free plan
# requires new_sqlite_classes). PR C1 ships WITH the migrations block below so
# the apply creates the namespace. PR C2 REMOVES the block. After the class
# has live objects, re-declaring migrations is code 10074 (provider v5 marks
# it WriteOnly, re-sends it every apply). The block must NEVER linger.
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

  # ⚠ MIGRATIONS DANCE, PR C1: create the SQLite-backed ChatChannel namespace.
  #   PR C2 REMOVES THIS BLOCK. It must never linger once the class has live
  #   objects (code 10074 — see the header comment and green's main.tf).
  migrations {
    new_sqlite_classes = ["ChatChannel"]
  }
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
