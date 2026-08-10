# talvi hub — the power-app front door at app.ygdcbtmc4u.uk.
#
# One hostname, one brand (A1/A2). The hub worker owns the `/*` fallback; the
# relay, chat, and cinto mount at more-specific path routes, each as its own
# Worker (most-specific-pattern wins — the exact split the blue release proved
# on talvi2). Full architecture: plans/talvi-hub-blueprint.md.
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }

  # Remote state on R2 (S3-compatible). Own key under the same talvi-tfstate
  # bucket and credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from GH
  # Actions secrets). Separate key from green (talvi/terraform.tfstate) and
  # blue (talvi/blue/terraform.tfstate), deliberately.
  backend "s3" {
    bucket = "talvi-tfstate"
    key    = "talvi/hub/terraform.tfstate"
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

# Proxied DNS record for app.ygdcbtmc4u.uk. 192.0.2.1 is a documentation
# address placeholder: proxied traffic is matched by the route patterns below
# and never actually resolved to it (same approach as blue's talvi2 record).
resource "cloudflare_dns_record" "app" {
  zone_id = var.talvi_zone_id
  name    = "app"
  content = "192.0.2.1"
  type    = "A"
  proxied = true
  ttl     = 1 # 1 = automatic; required by the provider and only valid when proxied
}

# The hub Worker — still small enough for `content = file(...)` (the
# @cloudflare/computer agent DO pushes it to ~208 KiB gzip; a
# content_file + content_sha256 reference is only needed past ~5 MB, the size
# that OOM'd blue's plan renderer).
#
# The hub is a dumb launcher of links (A4) — EXCEPT the agent (PR2): the MORE
# blade slot opens a chat panel that speaks to the AgentDO, a Durable Object
# owning a filesystem-only @cloudflare/computer Workspace. That is the only DO,
# storage, or secret-free surface the hub carries; nothing else will be added.
resource "cloudflare_workers_script" "talvi_hub" {
  account_id         = var.cloudflare_account_id
  script_name        = "talvi-hub"
  main_module        = "index.js"
  content            = file("${path.module}/dist/index.js") # built by esbuild in CI
  compatibility_date = "2026-08-10"

  # @cloudflare/computer needs node: crypto/events (nodejs_compat) and the
  # runtime's cloudflare:workers RPC classes — all provided by workerd, kept
  # external in the esbuild command (package.json build script).
  compatibility_flags = ["nodejs_compat"]

  bindings = [
    # The AgentDO — one Durable Object per agent name (the owner's prototype
    # agent is "main"; the Worker routes /agent/ws to it). class_name matches
    # the named export of dist/index.js (src/agent/agentdo.js). SQLite-backed
    # namespace, created by the PR2 (agent-2-do) apply's new_sqlite_classes
    # migration.
    {
      type       = "durable_object_namespace"
      name       = "AGENT"
      class_name = "AgentDO"
    },
  ]

  # NO `migrations` ARGUMENT — deliberate, and it must stay that way.
  #
  # PR2 (agent-2-do) shipped `migrations = { new_sqlite_classes = ["AgentDO"] }`
  # to create the SQLite-backed namespace (free plan requirement), and the PR2
  # apply ran it. Provider v5 marks `migrations` WriteOnly: Terraform does not
  # store it and re-sends it on EVERY apply, and Cloudflare refuses the
  # create-migration once the class is depended on by live Durable Objects
  # (code 10074 — the same trap that cost green hours, fixed there in PR #51,
  # and which bit the follow-up apply on 2026-08-10). Omitting the argument is
  # how Terraform sends null.
  #
  # Add a `migrations` block again ONLY to declare a genuinely NEW class, and
  # remove it again in the very next PR once applied. If this script is ever
  # destroyed and recreated from scratch, the create-migration must be
  # temporarily restored — the namespace would not exist then.
}

# The `/*` fallback route. More-specific routes (app.ygdcbtmc4u.uk/relay/*,
# /chat/*, /cinto/*) land on their own workers as they migrate.
resource "cloudflare_workers_route" "app_fallback" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/*"
  script  = cloudflare_workers_script.talvi_hub.script_name
}
