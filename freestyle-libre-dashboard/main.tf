# Leoncito dashboard — Cloudflare Pages project + routing for the /leoncito
# subpath on app.ygdcbtmc4u.uk. Managed by IAC per DSC; the actual site
# assets are still pushed with Wrangler (Pages asset deployment is
# Wrangler-only — no provider resource exists for it), see leoncito.yml.
#
# Routing: the apex host app.ygdcbtmc4u.uk is served by the talvi hub Worker
# (its `/*` fallback). A request to /leoncito is therefore rewritten to the
# Pages root (http_request_transform) and the origin is switched to the
# Pages project (http_request_origin) BEFORE the Worker route would consume
# it. If the hub ever claims /leoncito first, add a more-specific
# cloudflare_workers_route exception or raise with the hub owner — the
# rulesets here are the intended path.

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }

  # Remote state on R2 — own key under the shared talvi-tfstate bucket,
  # mirroring every sibling app (talvi/, talvi/learn/, talvi/chat/...).
  backend "s3" {
    bucket = "talvi-tfstate"
    key    = "talvi/leoncito/terraform.tfstate"
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

# Zone ID for ygdcbtmc4u.uk — a GitHub Actions VARIABLE, not a secret.
variable "talvi_zone_id" {
  type = string
}

# The Pages project itself. Assets are deployed by leoncito.yml via
# `wrangler pages deploy site --project-name leoncito-dashboard`.
resource "cloudflare_pages_project" "leoncito" {
  account_id        = var.cloudflare_account_id
  name              = "leoncito-dashboard"
  production_branch = "main"
}

# Rewrite /leoncito(/...) -> /(...) so the static site's root index.html is
# served (and its relative css/js/data paths keep resolving). Runs before the
# origin switch below.
resource "cloudflare_ruleset" "leoncito_path_rewrite" {
  zone_id     = var.talvi_zone_id
  name        = "Leoncito dashboard path rewrite"
  description = "Strip the /leoncito prefix before origin selection"
  # URI rewrites are only valid in the http_request_transform phase
  # (http_request_late_transform is header-only — API error 20088).
  phase = "http_request_transform"
  kind  = "zone"

  rules = [{
    # URL-rewrite transform rule: the action is "rewrite" (not "rewrite_uri"),
    # with the target under action_parameters.uri.
    action     = "rewrite"
    expression = "(http.host eq \"app.ygdcbtmc4u.uk\" and starts_with(http.request.uri.path, \"/leoncito\"))"
    action_parameters = {
      uri = {
        path = {
          expression = "regex_replace(http.request.uri.path, \"^/leoncito/*\", \"/\")"
        }
      }
    }
  }]
}

# Origin rule: send /leoncito to the Leoncito Pages project (host header
# override). Mirrors the plan's referenced tutorial
# (developers.cloudflare.com/rules/origin-rules/tutorials/point-to-pages-with-custom-domain/).
resource "cloudflare_ruleset" "leoncito_origin" {
  zone_id     = var.talvi_zone_id
  name        = "Leoncito dashboard origin"
  description = "Route the /leoncito subpath to the Leoncito Pages project"
  phase       = "http_request_origin"
  kind        = "zone"

  rules = [{
    action     = "route"
    expression = "(http.host eq \"app.ygdcbtmc4u.uk\" and starts_with(http.request.uri.path, \"/leoncito\"))"
    action_parameters = {
      host_header = "leoncito-dashboard.pages.dev"
    }
  }]
}
