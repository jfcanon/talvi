// Custom worker entry point for talvi-blue with Sentry integration.
// This wraps the OpenNext-generated handler with Sentry error tracking.
import { withSentry } from "@sentry/cloudflare";

// Import the OpenNext-generated handler.
import openNextHandler from "./.open-next/worker.js";

// Wrap the handler with Sentry using the v8 API.
// withSentry takes an options callback (receives env) and the handler object.
const sentryHandler = withSentry(
  (env) => ({
    dsn: env.SENTRY_DSN,
    environment: "production",
    tracesSampleRate: 0.1,
    // No client-side bundling — CSP default-src 'none' forbids it.
    // All Sentry instrumentation runs server-side only.
    enableTracing: false,
  }),
  openNextHandler
);

// Export the wrapped handler.
export default sentryHandler;