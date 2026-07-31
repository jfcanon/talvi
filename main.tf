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
      id         = "expire-d7"
      enabled    = true
      conditions = { prefix = "d7/" }
      delete_objects_transition = {
        condition = { max_age = 7 * 24 * 60 * 60, type = "Age" } # 604800
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
  ]
}

# A fresh script's workers.dev route defaults to disabled — encoded from the
# relay project's first deploy. The account-level workers.dev subdomain
# itself (ygdcbtmc4u) already exists and needs no action here.
resource "cloudflare_workers_script_subdomain" "talvi_web_subdomain" {
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.talvi_web.script_name
  enabled          = true
  previews_enabled = false
}
