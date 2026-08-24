# talvi

A small, personal file-drop-and-share tool. Upload a file, get an unlisted link, it expires on its own.

Terraform for this project runs only in CI — never locally. See `RUNBOOK.md` (added in a later step) for operations.

<!-- Step 2 determinism check: this no-op PR exists only to run `terraform plan`
     a second time against unchanged source. A "No changes" result proves the
     esbuild bundle is byte-reproducible; any diff here means the build is
     non-deterministic and must be fixed before Step 3. -->

# Trigger terraform apply
