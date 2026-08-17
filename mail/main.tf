# talvi mail — Cloudflare Email Routing for ygdcbtmc4u.uk.
#
# Forwards jangofett86@ygdcbtmc4u.uk → jangofett86@gmail.com (NID-358).
# Owner confirmed privacy, path A (Email Routing), and MX add.
# Terraform never runs locally — PR → plan, merge → apply.
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }

  backend "s3" {
    bucket = "talvi-tfstate"
    key    = "talvi/mail/terraform.tfstate"
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

# POST /email/routing/dns enables routing and adds+locks the required MX,
# SPF (include:_spf.mx.cloudflare.net), and DKIM records. Do not also declare
# those as cloudflare_dns_record — they would fight this resource. Destroying
# this resource removes the MX/SPF/DKIM it added.
resource "cloudflare_email_routing_dns" "apex" {
  zone_id = var.talvi_zone_id
  name    = "ygdcbtmc4u.uk"
}

# Account-level destination. First apply sends a verification email to this
# address; forwarding is inert until the owner clicks it. `verified` is
# read-only — Terraform cannot complete that step.
resource "cloudflare_email_routing_address" "gmail" {
  account_id = var.cloudflare_account_id
  email      = "jangofett86@gmail.com"
}

# Literal To: match only. Does not touch the existing disabled catch-all drop.
resource "cloudflare_email_routing_rule" "jangofett86" {
  zone_id = var.talvi_zone_id
  name    = "jangofett86 → gmail"
  enabled = true
  matchers = [{
    type  = "literal"
    field = "to"
    value = "jangofett86@ygdcbtmc4u.uk"
  }]
  actions = [{
    type  = "forward"
    value = [cloudflare_email_routing_address.gmail.email]
  }]
  depends_on = [cloudflare_email_routing_dns.apex]
}
