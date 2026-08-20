# talvi mail — Cloudflare Email Routing + Email Sending for ygdcbtmc4u.uk.
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

# ============================================================
# EMAIL ROUTING (Inbound) — existing configuration
# ============================================================

# Apex MX/SPF as zone records. cloudflare_email_routing_dns rejected the
# apex with error 2007 (must be a subdomain). Provider v5 name is
# cloudflare_dns_record (v4's cloudflare_record).
resource "cloudflare_dns_record" "mx_isaac" {
  zone_id  = var.talvi_zone_id
  name     = "@"
  type     = "MX"
  content  = "isaac.mx.cloudflare.net."
  priority = 92
  ttl      = 1
  proxied  = false
}

resource "cloudflare_dns_record" "mx_clara" {
  zone_id  = var.talvi_zone_id
  name     = "@"
  type     = "MX"
  content  = "clara.mx.cloudflare.net."
  priority = 92
  ttl      = 1
  proxied  = false
}

resource "cloudflare_dns_record" "mx_amira" {
  zone_id  = var.talvi_zone_id
  name     = "@"
  type     = "MX"
  content  = "amira.mx.cloudflare.net."
  priority = 92
  ttl      = 1
  proxied  = false
}

resource "cloudflare_dns_record" "spf" {
  zone_id = var.talvi_zone_id
  name    = "@"
  type    = "TXT"
  content = "v=spf1 include:_spf.mx.cloudflare.net ~all"
  ttl     = 1
  proxied = false
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
  depends_on = [
    cloudflare_dns_record.mx_isaac,
    cloudflare_dns_record.mx_clara,
    cloudflare_dns_record.mx_amira,
    cloudflare_dns_record.spf,
  ]
}

# Catch-all rule → quickmail Worker
# Using dedicated catch_all resource (provider v5) which supports worker action.
resource "cloudflare_email_routing_catch_all" "quickmail" {
  zone_id = var.talvi_zone_id
  name    = "catch-all → quickmail worker"
  enabled = true
  matchers = [{
    type = "all"
  }]
  actions = [{
    type  = "worker"
    value = ["quickmail"]
  }]
  depends_on = [
    cloudflare_email_routing_rule.jangofett86,
  ]
}

# ============================================================
# EMAIL SENDING (Outbound) — cf-bounce subdomain
# ============================================================
#
# Email Sending DNS records (cf-bounce MX/SPF/DKIM) are created
# AUTOMATICALLY by Cloudflare when Email Sending is enabled in the
# dashboard (Email → Email Sending → Enable). They are managed by
# Cloudflare and not exposed as Terraform resources.
#
# To enable Email Sending:
# 1. Go to Cloudflare Dashboard → Email → Email Sending
# 2. Select ygdcbtmc4u.uk → Enable
# 3. Cloudflare will create cf-bounce.ygdcbtmc4u.uk with MX/SPF/DKIM
#
# The DMARC record below protects both routing and sending.

# DMARC record for the apex domain (protects both routing and sending)
resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.talvi_zone_id
  name    = "_dmarc"
  type    = "TXT"
  content = "v=DMARC1; p=none; rua=mailto:dmarc@ygdcbtmc4u.uk; ruf=mailto:dmarc@ygdcbtmc4u.uk; fo=1"
  ttl     = 1
  proxied = false
}