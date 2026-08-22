# DECOMMISSIONED 2026-08-21: talvi2.ygdcbtmc4u.uk (blue release) fully removed.
# Storage (D1 talvi-blue-meta, R2 talvi-blue-drop) destroyed 2026-08-21.
# Serving surface removed 2026-08-10; this file preserved for reference only.
# Green (talvi.ygdcbtmc4u.uk, root main.tf) is untouched.
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

# REMOVED 2026-08-21: Blue storage resources (D1 talvi-blue-meta, R2 talvi-blue-drop, lifecycle)
# were destroyed as part of full blue decommissioning.
# Data inventory: 7 expired drop metadata rows + empty R2 bucket.
# Terraform apply destroys these resources via the state key talvi/blue/terraform.tfstate.

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

