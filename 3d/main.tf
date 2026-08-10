# talvi 3d — the 3D style study at 3d.ygdcbtmc4u.uk.
#
# A public, fully procedural three.js scroll-world that explores whether
# talvi's neon-noir instrument aesthetic survives translation into 3D (see
# plans/talvi-3d-style-study-blueprint.md in sagwebapp). Pure visual study: no
# product function, no storage, no auth. Same shape as hub/main.tf — its own
# state key under the same talvi-tfstate bucket and credentials.
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }

  backend "s3" {
    bucket = "talvi-tfstate"
    key    = "talvi/3d/terraform.tfstate"
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

# Proxied DNS record for 3d.ygdcbtmc4u.uk. 192.0.2.1 is a documentation
# address placeholder: proxied traffic is matched by the route pattern below
# and never actually resolved to it (hub's approach, reused verbatim).
resource "cloudflare_dns_record" "three_d" {
  zone_id = var.talvi_zone_id
  name    = "3d"
  content = "192.0.2.1"
  type    = "A"
  proxied = true
  ttl     = 1 # 1 = automatic; required by the provider and only valid when proxied
}

# The 3d Worker. Tiny server code — the ~600 KiB client scene bundle is
# embedded as a string in dist/index.js, which keeps `content = file(...)`
# comfortable (hub's note: a content_file + content_sha256 reference is only
# needed once a script approaches ~5 MB, where blue's plan renderer OOM'd).
#
# NO Durable Objects, NO storage, NO secrets — a public static-feeling page
# (A4). Nothing here needs a `migrations` block and nothing ever will.
resource "cloudflare_workers_script" "talvi_3d" {
  account_id         = var.cloudflare_account_id
  script_name        = "talvi-3d"
  main_module        = "index.js"
  content            = file("${path.module}/dist/index.js") # built by esbuild in CI
  compatibility_date = "2026-08-10"
}

# The route that makes 3d.ygdcbtmc4u.uk serve this worker.
resource "cloudflare_workers_route" "three_d" {
  zone_id = var.talvi_zone_id
  pattern = "3d.ygdcbtmc4u.uk/*"
  script  = cloudflare_workers_script.talvi_3d.script_name
}
