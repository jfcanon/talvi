// Next.js config for the blue (Next.js) release.
// initOpenNextCloudflareForDev makes `next dev` able to read Cloudflare
// bindings locally; it is a no-op in production builds.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();

/** @type {import('next').NextConfig} */
const nextConfig = {
  // OpenNext deploys the app to Cloudflare Workers (Node.js runtime).
  // Route handlers and pages below use the default Node.js runtime.
};

export default nextConfig;
