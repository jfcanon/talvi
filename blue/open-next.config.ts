import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache, no image optimization, no multi-worker split — this
// app is dynamic end to end (uploads, downloads, markdown conversion), so the
// default OpenNext config is correct. See plans/talvi-blue-release-blueprint.md.
export default defineCloudflareConfig();
