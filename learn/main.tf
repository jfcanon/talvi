# talvi learn — the Tribunal Learn course, mounted at app.ygdcbtmc4u.uk/learn.
#
# PR2 was the inert skeleton (NID-97): own state key, D1 talvi-learn-meta
# (created here but not bound — the binding lands in PR4 with the data layer),
# the /learn route, and a worker that serves only /learn/healthz plus a
# coming-soon placeholder. PR3 (NID-98) adds the Clerk owner-only gate (decision
# 2): three Clerk bindings + nodejs_compat. No data layer (PR4). Full
# architecture: plans/talvi-learn-blueprint.md.
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }

  # Remote state on R2 (S3-compatible). Own key under the same talvi-tfstate
  # bucket and credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from GH
  # Actions secrets). Separate from every sibling key (talvi/terraform.tfstate,
  # talvi/blue/…, talvi/hub/…, talvi/relay/…, talvi/chat/…, talvi/3d/…),
  # deliberately. Blueprint D.5 records the factual discovery that decision 1's
  # "own tfstate bucket key (talvi-learn-tfstate)" is satisfied by the key
  # talvi/learn/terraform.tfstate in that same shared bucket — the isolation
  # property is identical and it matches every sibling app.
  backend "s3" {
    bucket = "talvi-tfstate"
    key    = "talvi/learn/terraform.tfstate"
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

# Clerk auth (PR3, decision 2). Secret key is a secret_text binding so it never
# appears in state; the publishable key is public by design and ships as plain
# text. The JWT key is Clerk's public verification key (PEM) — also public, but
# stored in Bitwarden with its peers; passing it as jwtKey makes session
# verification networkless (green's Step 8 pattern, same as blue/hub/relay).
variable "clerk_secret_key" {
  type = string
}

variable "clerk_publishable_key" {
  type = string
}

variable "clerk_jwt_key" {
  type = string
}

# Learn's own D1 database (decision 3) — separate from talvi-meta and
# talvi-blue-meta (release isolation). Created here in PR2 as the resource; the
# worker binding lands in PR4 with the data layer. No schema exists yet — the
# CREATE TABLE IF NOT EXISTS DDL ships in PR4 (learn/src/lib/store.js).
resource "cloudflare_d1_database" "talvi_learn_meta" {
  account_id       = var.cloudflare_account_id
  name             = "talvi-learn-meta"
  read_replication = { mode = "disabled" }
}

# The learn Worker — PR3 adds the Clerk owner-only gate (three bindings) and
# nodejs_compat (@clerk/backend's networkless JWT verifier needs it — same as
# relay, relay/main.tf:83). `content = file(...)` is fine (green/hub pattern;
# content_file + content_sha256 only becomes necessary past ~5 MB). D1 binds in
# PR4. NO `migrations` block — no Durable Objects, and a stale one would be
# re-sent on every apply (hub/relay record, code 10074).
resource "cloudflare_workers_script" "talvi_learn" {
  account_id         = var.cloudflare_account_id
  script_name        = "talvi-learn"
  main_module        = "index.js"
  content            = file("${path.module}/dist/index.js") # built by esbuild in CI
  compatibility_date = "2026-08-14"

  # nodejs_compat: @clerk/backend (the networkless JWT verifier) is built for
  # the Node.js compat layer — same flag relay uses for the identical gate
  # (relay/main.tf:83). Without it authenticateRequest throws at runtime.
  compatibility_flags = ["nodejs_compat"]

  bindings = [
    # Clerk auth — the learn gate verifies the host-wide __session cookie with
    # @clerk/backend + jwtKey. ALL THREE keys are required: authenticateRequest
    # needs the secret key, publishableKey, and jwtKey (the blue/hub/relay
    # shapes; missing one = fail-closed, per src/lib/auth.js). CLERK_SECRET_KEY
    # is a secret_text binding (never in state); the publishable and JWT keys
    # are public by design (plain_text).
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
}

# Routes: app.ygdcbtmc4u.uk/learn (exact) and /learn/*. The hub owns the `/*`
# fallback; these more-specific patterns win (blueprint B.1). The exact /learn
# route matters: the hub blade will link to /learn (no trailing slash), and a
# `learn/*` wildcard alone would 404 it — the same lesson relay/chat encoded in
# their root routes.
resource "cloudflare_workers_route" "learn" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/learn/*"
  script  = cloudflare_workers_script.talvi_learn.script_name
}

resource "cloudflare_workers_route" "learn_root" {
  zone_id = var.talvi_zone_id
  pattern = "app.ygdcbtmc4u.uk/learn"
  script  = cloudflare_workers_script.talvi_learn.script_name
}
