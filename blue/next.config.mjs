// Next.js config for the blue (Next.js) release.
// initOpenNextCloudflareForDev makes `next dev` able to read Cloudflare
// bindings locally; it is a no-op in production builds.
import { execSync } from "node:child_process";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();

/** @type {import('next').NextConfig} */
const nextConfig = {
  // OpenNext deploys the app to Cloudflare Workers (Node.js runtime).
  // Route handlers and pages below use the default Node.js runtime.

  // Deterministic build ID. Next's default is a RANDOM string per build, which
  // leaks into the _next/static/<ID> asset paths and the bundled
  // dist-worker/worker.js. The OpenNext output is a Terraform input
  // (`content = file("${path.module}/dist-worker/worker.js")` and the
  // `.open-next/assets` directory), so a random ID would turn every build into
  // a perpetual plan diff — the exact failure the relay/talvi determinism rule
  // describes (03-lessons-learned §3). Same commit, same ID, same bytes out.
  //
  // The commit SHA is also the right cache key: when the code changes, the ID
  // changes and every static URL for it does too, so no stale-cache cliff.
  generateBuildId: async () => {
    try {
      return execSync("git rev-parse --short=8 HEAD", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim();
    } catch {
      // No git (e.g. a source tarball); a fixed fallback keeps the build
      // reproducible even though it forfeits per-code cache busting.
      return "no-git";
    }
  },
};

export default nextConfig;
