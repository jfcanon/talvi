#!/usr/bin/env python3
"""
clerk_redirect_urls.py — manage talvi's Clerk redirect URL allowlist.

The Clerk dashboard's "Redirect URLs" page is a UI over the Backend API.
This script drives the API so the config lives in code, not clicks. It is the
IaC-style counterpart to mint_token.py in the relay: reads the secret from
Bitwarden at use time, never commits it, prints only the resulting allowlist.

Usage (run from the talvi repo root):
  ./scripts/clerk_redirect_urls.py --list
  ./scripts/clerk_redirect_urls.py --add https://talvi.ygdcbtmc4u.uk/*
  ./scripts/clerk_redirect_urls.py --default https://talvi.ygdcbtmc4u.uk
  ./scripts/clerk_redirect_urls.py --remove <id>

Requires Bitwarden unlocked (BW_PASSWORD in env, as the rest of the project).
The secret key lives in Bitwarden item 'clerckapikey', field 'password'.
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

CLERK_API = "https://api.clerk.com/v1"


def bw_get(field, item):
    """Fetch a secret from Bitwarden via the CLI, never printing it."""
    # The Clerk key mapping lives in the relay repo's .secrets.env (the project
    # that seeded Clerk). Look for it there — it is the one file that maps
    # CLERK_* names to Bitwarden items.
    candidates = [
        os.path.join(os.path.dirname(__file__), "..", "..", "relay", ".secrets.env"),
        os.path.join(os.getcwd(), ".secrets.env"),
    ]
    env_path = next((p for p in candidates if os.path.exists(p)), None)
    if env_path is None:
        raise SystemExit("could not find .secrets.env (looked in relay/ and cwd)")
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("BW_") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k, v)
    # BW_PASSWORD is required to unlock; the mapping comes from .secrets.env.
    session = subprocess.run(
        ["bw", "unlock", "--passwordenv", "BW_PASSWORD", "--raw"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    subprocess.run(["bw", "sync", "--session", session], capture_output=True, check=True)
    value = subprocess.run(
        ["bw", "get", field, item, "--session", session],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    subprocess.run(["bw", "lock"], capture_output=True)
    return value


def api(method, path, body=None, token=None):
    req = urllib.request.Request(
        f"{CLERK_API}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            # Neutral, but NOT urllib's default: Cloudflare's Browser Integrity
            # Check 403s (error 1010) on Python-urllib/*. Same fix as the
            # relay's push.py — says nothing about who we are, just avoids the
            # blocklist.
            "User-Agent": "clerk-config/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        print(f"API {method} {path} failed: {e.code} {e.read().decode()}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="list allowlisted redirect URLs")
    parser.add_argument("--add", metavar="URL", help="add a redirect URL to the allowlist")
    parser.add_argument("--default", metavar="URL", help="set the default redirect URL")
    parser.add_argument("--remove", metavar="ID", help="remove a redirect URL by id")
    args = parser.parse_args()

    token = bw_get("password", "clerckapikey")

    if args.list or not any([args.add, args.default, args.remove]):
        _, data = api("GET", "/redirect_urls", token=token)
        # GET /redirect_urls returns a bare array, not a paginated envelope.
        items = data if isinstance(data, list) else data.get("data", [])
        for item in items:
            print(f"{item['id']}  {item['url']}")
        if args.list:
            return

    if args.add:
        status, item = api("POST", "/redirect_urls", {"url": args.add}, token)
        print(f"added {item.get('id')}  {item.get('url')}")

    if args.default:
        # PATCH /instance — update the default redirect URL.
        status, _ = api("PATCH", "/instance", {"default_redirect_url": args.default}, token)
        print(f"default redirect set to {args.default}")

    if args.remove:
        status, _ = api("DELETE", f"/redirect_urls/{args.remove}", token=token)
        print(f"removed {args.remove}")


if __name__ == "__main__":
    main()
