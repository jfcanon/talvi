// Route-handler bridge to the Workers bindings.
//
// @opennextjs/cloudflare exposes the worker's env/ctx to the Next.js app; this
// is the single call site so that OpenNext-specific import does not leak into
// every handler. Returns the whole context so handlers can also use
// ctx.waitUntil() for fire-and-forget work, exactly as the green worker's
// fetch(request, env, ctx) does.
//
// The bindings themselves (DB, BUCKET, RL_UPLOAD, RL_READ, AI) are created by
// Terraform in blue/main.tf; the code only ever reads them off `env`, and it
// does so in the plain-JS lib modules below so nothing here has to be typed.
import { getCloudflareContext } from "@opennextjs/cloudflare";

export function getCloudflare() {
  return getCloudflareContext({ async: true });
}
