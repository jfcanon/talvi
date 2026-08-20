// quickmail Worker — handles inbound emails via Cloudflare Email Routing catch-all
// Receives emails sent to *@ygdcbtmc4u.uk and processes them

import { EmailMessage } from "cloudflare:email";

export default {
  async email(message, env, ctx) {
    // message is an EmailMessage (cloudflare:email)
    // https://developers.cloudflare.com/email-routing/email-workers/

    const { from, to, subject, headers, raw, rawSize } = message;

    // Log the incoming email
    console.log(`Received email from: ${from}, to: ${to.join(", ")}, subject: ${subject}`);

    // Extract email body
    let textBody = "";
    let htmlBody = "";

    if (message.raw) {
      // Parse the raw email
      const rawEmail = new TextDecoder().decode(raw);
      const parts = parseRawEmail(rawEmail);
      textBody = parts.text || "";
      htmlBody = parts.html || "";
    }

    // Process the email based on recipient
    await processEmail({
      from,
      to,
      subject,
      textBody,
      htmlBody,
      headers,
      rawSize,
    }, env, ctx);

    // Return success - email is considered delivered
    return;
  },

  async fetch(request, env, ctx) {
    // Health check endpoint
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }
    return new Response("quickmail worker", { status: 200 });
  },
};

// Parse raw email into text and HTML parts
function parseRawEmail(raw) {
  const result = { text: "", html: "" };

  // Simple boundary-based parsing for multipart emails
  const boundaryMatch = raw.match(/boundary="?([^"\r\n]+)"?/);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = raw.split(`--${boundary}`);

    for (const part of parts) {
      if (part.includes("Content-Type: text/plain")) {
        const contentStart = part.indexOf("\r\n\r\n");
        if (contentStart !== -1) {
          result.text = part.slice(contentStart + 4).trim().replace(/--$/, "");
        }
      } else if (part.includes("Content-Type: text/html")) {
        const contentStart = part.indexOf("\r\n\r\n");
        if (contentStart !== -1) {
          result.html = part.slice(contentStart + 4).trim().replace(/--$/, "");
        }
      }
    }
  } else if (raw.includes("Content-Type: text/plain")) {
    // Single part plain text
    const contentStart = raw.indexOf("\r\n\r\n");
    if (contentStart !== -1) {
      result.text = raw.slice(contentStart + 4).trim();
    }
  } else if (raw.includes("Content-Type: text/html")) {
    // Single part HTML
    const contentStart = raw.indexOf("\r\n\r\n");
    if (contentStart !== -1) {
      result.html = raw.slice(contentStart + 4).trim();
    }
  }

  return result;
}

// Process the email - customize this based on your needs
async function processEmail(email, env, ctx) {
  const { from, to, subject, textBody, htmlBody, headers, rawSize } = email;

  // Example: Forward to a webhook, store in R2/D1, send notification, etc.
  // For now, just log the details

  console.log("=== Email Received ===");
  console.log(`From: ${from}`);
  console.log(`To: ${to.join(", ")}`);
  console.log(`Subject: ${subject}`);
  console.log(`Size: ${rawSize} bytes`);
  console.log(`Text preview: ${textBody.slice(0, 200)}`);
  console.log(`HTML preview: ${htmlBody.slice(0, 200)}`);

  // TODO: Add your email processing logic here
  // Examples:
  // - Forward to a webhook (Discord, Slack, etc.)
  // - Store in D1 database
  // - Save attachments to R2
  // - Trigger other workflows
  // - Reply with auto-response

  // Example: Forward to a webhook if configured
  if (env.WEBHOOK_URL) {
    try {
      await fetch(env.WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to,
          subject,
          text: textBody,
          html: htmlBody,
          headers: Object.fromEntries(headers),
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (err) {
      console.error("Webhook delivery failed:", err);
    }
  }
}