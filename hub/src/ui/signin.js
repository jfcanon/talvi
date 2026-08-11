// The custom Clerk sign-in page — "/sign-in" on the app ROOT. Ported from the
// relay (which ported the blue release, s7 §4) — the settled flow, moved not
// rewritten: custom UI, strict CSP with a nonce, no unsafe-inline, no
// unsafe-eval in prod. Also the OAuth return page — "/sso-callback": Clerk
// redirects the browser here after a Google/GitHub/Discord flow, and this
// module renders the page that calls Clerk.handleRedirectCallback().
//
// Paths are PREFIX-aware; the hub's PREFIX is "" (the root), so the sign-in
// lives at /sign-in, redirects home to /, and points clerk-js's OAuth return
// at /sso-callback. The stylesheet is the hub's own /h.css.
//
// These are the TWO pages that load clerk-js. They are built deliberately
// OUTSIDE renderPage() because they need two things renderPage does not provide:
//   1. A per-request nonce threaded into both the CSP header and the <script>
//      tags (clerk-js and our own bootstrap). The rest of the app's CSP is
//      default-src 'none' and never changes; these pages alone widen to the
//      strict Clerk CSP from session3/11 §4.3.
//   2. An inline bootstrap script (nonce'd) that drives the custom flow:
//      Clerk.load → signIn.create({identifier, password}) → setActive, and for
//      the SSO path authenticateWithRedirect → /sso-callback →
//      handleRedirectCallback.
//
// The markup uses the same instrument language as the relay's sign-in (frame,
// console register, hud labels) so the sign-in reads as part of the machine.
import { ASSET_VERSION } from "../generated/assets.js";
import { PREFIX } from "../prefix.js";

// Pinned to the exact build the prod instance serves (verified live:
// clerk.ygdcbtmc4u.uk/npm/@clerk/clerk-js@5.127.1/dist/clerk.browser.js).
// The route handler supplies publishableKey (a binding) so no key is baked
// into this file or into the repo.
const CLERK_JS_URL =
  "https://clerk.ygdcbtmc4u.uk/npm/@clerk/clerk-js@5.127.1/dist/clerk.browser.js";

// The static SSO/web3 buttons the server renders. The bootstrap reads the
// instance's supported_first_factors and reveals the advertised ones, so the
// button set here is the universe the app can offer; nothing is shown that the
// dashboard does not advertise. strategy "web3" is a single WALLET button that
// dispatches to whichever wallet the instance advertises.
const SSO_OPTIONS = [
  { strategy: "oauth_google", label: "GOOGLE" },
  { strategy: "oauth_github", label: "GITHUB" },
  { strategy: "oauth_discord", label: "DISCORD" },
  { strategy: "web3", label: "WALLET" },
];

// Strict Clerk CSP (session3/11 §4.3): nonce + strict-dynamic, no
// unsafe-inline, no unsafe-eval in prod. strict-dynamic makes the nonce the
// trust anchor: the nonce'd clerk-js <script> and the nonce'd bootstrap are
// trusted, and any script THEY load is trusted with them. The https: fallback
// only matters for browsers without strict-dynamic support. style-src 'self'
// is safe because the custom form is our own markup with our own /h.css — no
// Clerk CSS-in-JS anywhere.
//
// Shared by BOTH clerk-js pages: /sign-in and /sso-callback. The OAuth
// redirect itself is a top-level navigation, so it needs no extra directive —
// the existing connect-src (clerk.ygdcbtmc4u.uk, *.protect.clerk.com) is all
// the callback page needs. This is the blue-3b-auth-options reason no CSP
// change accompanies the SSO buttons.
export function signInCsp(nonce) {
  return [
    "default-src 'self'",
    "script-src 'self' 'strict-dynamic' 'nonce-" + nonce + "' https: http:",
    "style-src 'self'",
    "img-src 'self' data: https://img.clerk.com",
    "connect-src 'self' https://clerk.ygdcbtmc4u.uk https://*.protect.clerk.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

// The sign-in bootstrap. nonce-safe by construction: it is inserted inline with
// the same nonce that appears in the CSP. It wires the form to the Clerk custom
// flow AND drives the SSO row. It adds no markup — every button is already in
// the server-rendered HTML, this only toggles visibility and attaches handlers,
// which keeps the "no inline style, no inline script that renders content" rule
// intact (the server renders everything).
function bootstrapScript(nonce, publishableKey, redirect) {
  return (
    '<script nonce="' + nonce + '">' +
    "(async function () {\n" +
    "  'use strict';\n" +
    "  var pub = " + JSON.stringify(publishableKey) + ";\n" +
    "  var root = window.location.origin + " + JSON.stringify(PREFIX) + ";\n" +
    // The return target: the page the visitor came from (?redirect=), or home.
    "  var target = " + JSON.stringify(redirect || "") + " || root + '/';\n" +
    "  if (target.charAt(0) !== '/') target = root + '/';\n" +
    "  var form = document.getElementById('si-form');\n" +
    "  var email = document.getElementById('si-email');\n" +
    "  var password = document.getElementById('si-pass');\n" +
    "  var codeWrap = document.getElementById('si-code-wrap');\n" +
    "  var code = document.getElementById('si-code');\n" +
    "  var msg = document.getElementById('si-msg');\n" +
    "  var btn = document.getElementById('si-submit');\n" +
    "  var sso = document.getElementById('si-sso');\n" +
    "  var current = null;\n" +
    "  if (!form) return;\n" +
    "  var clerk = null;\n" +
    "  function loadClerk() {\n" +
    "    if (!clerk) clerk = new Promise(function (resolve, reject) {\n" +
    "      (function wait() {\n" +
    "        if (window.Clerk) {\n" +
    "          window.Clerk.load({ publishableKey: pub }).then(function () {\n" +
    "            resolve(window.Clerk);\n" +
    "          }, reject);\n" +
    "        } else if (document.readyState === 'complete') {\n" +
    "          reject(new Error('clerk-js did not load'));\n" +
    "        } else {\n" +
    "          setTimeout(wait, 100);\n" +
    "        }\n" +
    "      })();\n" +
    "    });\n" +
    "    return clerk;\n" +
    "  }\n" +
    "  function factorsOf(si) {\n" +
    "    return (si.supportedFirstFactors || []).map(function (f) { return f.strategy; });\n" +
    "  }\n" +
    "  function setMsg(kind, text) {\n" +
    "    msg.className = 'msg' + (kind === 'bad' ? ' msg--bad' : '');\n" +
    "    msg.textContent = text;\n" +
    "  }\n" +
    // ---- SSO / web3: reveal whatever the instance advertises ----
    "  function web3Method(strategy) {\n" +
    "    var map = {\n" +
    "      web3_metamask_signature: 'authenticateWithMetamask',\n" +
    "      web3_coinbase_wallet_signature: 'authenticateWithCoinbaseWallet',\n" +
    "      web3_okx_wallet_signature: 'authenticateWithOKXWallet',\n" +
    "      web3_base_signature: 'authenticateWithBase'\n" +
    "    };\n" +
    "    return map[strategy] || 'authenticateWithMetamask';\n" +
    "  }\n" +
    "  async function wireAlternates() {\n" +
    "    if (!sso) return;\n" +
    "    var shown = false;\n" +
    "    try {\n" +
    "      var c = await loadClerk();\n" +
    "      var probe = await c.client.signIn.create({});\n" +
    "      var factors = factorsOf(probe);\n" +
    "      var web3 = null;\n" +
    "      for (var i = 0; i < factors.length; i++) {\n" +
    "        if (factors[i].indexOf('web3_') === 0) web3 = factors[i];\n" +
    "      }\n" +
    "      sso.setAttribute('data-web3', web3 || '');\n" +
    "      var buttons = sso.querySelectorAll('button[data-strategy]');\n" +
    "      for (var j = 0; j < buttons.length; j++) {\n" +
    "        var b = buttons[j];\n" +
    "        var st = b.getAttribute('data-strategy');\n" +
    "        var active = st === 'web3' ? !!web3 : factors.indexOf(st) !== -1;\n" +
    "        if (!active) { b.classList.add('hidden'); continue; }\n" +
    "        b.classList.remove('hidden');\n" +
    "        shown = true;\n" +
    "      }\n" +
    "      if (shown) sso.classList.remove('hidden');\n" +
    "    } catch (err) {\n" +
    "      // Instance unreachable: keep the row hidden, the form still works.\n" +
    "    }\n" +
    "  }\n" +
    "  async function runAlternate(strategy) {\n" +
    "    msg.className = 'msg hidden';\n" +
    "    try {\n" +
    "      var c = await loadClerk();\n" +
    "      var origin = window.location.origin;\n" +
    "      if (strategy === 'web3') {\n" +
    "        var w3 = (sso && sso.getAttribute('data-web3')) || 'web3_metamask_signature';\n" +
    "        var attempt = await c.client.signIn[web3Method(w3)]();\n" +
    "        if (attempt.status === 'complete') {\n" +
    "          await c.setActive({ session: attempt.createdSessionId });\n" +
    "          window.location.href = target;\n" +
    "          return;\n" +
    "        }\n" +
    "        setMsg('', 'REQUIRED: ' + attempt.status);\n" +
    "      } else {\n" +
    "        // Full-page redirect to the provider; the browser leaves this page.\n" +
    "        await c.client.signIn.authenticateWithRedirect({\n" +
    "          strategy: strategy,\n" +
    "          redirectUrl: root + '/sso-callback?redirect=' + encodeURIComponent(target),\n" +
    "          redirectUrlComplete: target\n" +
    "        });\n" +
    "        return;\n" +
    "      }\n" +
    "    } catch (err) {\n" +
    "      var errCode = (err && err.errors && err.errors[0]) ? err.errors[0].code : '';\n" +
    "      if (errCode === 'session_exists' || /session already exists/i.test(String(err && err.message))) { sessionAlreadyExists(); return; }\n" +
    "      var detail = (err && err.errors && err.errors[0]) ? (err.errors[0].long_message || err.errors[0].message) : (err && err.message ? err.message : 'sign in failed');\n" +
    "      setMsg('bad', 'REFUSED — ' + detail);\n" +
    "    }\n" +
    "    btn.disabled = false;\n" +
    "    if (sso) {\n" +
    "      var bb = sso.querySelector('button[aria-disabled=\"true\"]');\n" +
    "      if (bb) bb.removeAttribute('aria-disabled');\n" +
    "    }\n" +
    "  }\n" +
    "  if (sso) {\n" +
    "    sso.addEventListener('click', function (e) {\n" +
    "      var b = e.target.closest('button[data-strategy]');\n" +
    "      if (!b || b.getAttribute('aria-disabled') === 'true') return;\n" +
    "      b.setAttribute('aria-disabled', 'true');\n" +
    "      btn.disabled = true;\n" +
    "      runAlternate(b.getAttribute('data-strategy'));\n" +
    "    });\n" +
    "  }\n" +
    // An active session already exists (e.g. the sign-in page was left open
    // after signing in elsewhere, or the server-side bounce missed): don't
    // show a form that Clerk will refuse with "Session already exists" — send
    // the visitor straight back where they were going.
    "  function sessionAlreadyExists() {\n" +
    "    window.location.href = target;\n" +
    "  }\n" +
    "  async function checkExisting() {\n" +
    "    try {\n" +
    "      var c = await loadClerk();\n" +
    "      if (c.session) { sessionAlreadyExists(); return; }\n" +
    "    } catch (err) {}\n" +
    "  }\n" +
    "  checkExisting();\n" +
    "  wireAlternates();\n" +
    // ---- the form: email + password, email-link fallback, 2FA code ----
    "  function showCodeStep(attempt) {\n" +
    "    current = attempt;\n" +
    "    codeWrap.classList.remove('hidden');\n" +
    "    code.value = '';\n" +
    "    code.focus();\n" +
    "    btn.disabled = false;\n" +
    "    btn.textContent = 'VERIFY';\n" +
    "    msg.className = 'msg';\n" +
    "    msg.textContent = 'CHECK YOUR EMAIL — enter the verification code.';\n" +
    "  }\n" +
    "  form.addEventListener('submit', async function (e) {\n" +
    "    e.preventDefault();\n" +
    "    msg.className = 'msg hidden';\n" +
    "    btn.disabled = true;\n" +
    "    try {\n" +
    "      var c = await loadClerk();\n" +
    "      if (current && !codeWrap.classList.contains('hidden')) {\n" +
    "        // Second step: the 2FA code the instance sent by email.\n" +
    "        var done = await current.attemptSecondFactor({ strategy: 'email_code', code: code.value.trim() });\n" +
    "        if (done.status === 'complete') {\n" +
    "          await c.setActive({ session: done.createdSessionId });\n" +
    "          window.location.href = target;\n" +
    "          return;\n" +
    "        }\n" +
    "        msg.className = 'msg msg--bad';\n" +
    "        msg.textContent = 'REQUIRED: ' + (done.status || 'verify the code');\n" +
    "        btn.disabled = false;\n" +
    "        btn.textContent = 'VERIFY';\n" +
    "        return;\n" +
    "      }\n" +
    "      btn.textContent = 'SIGNING IN';\n" +
    "      var attempt = await c.client.signIn.create({ identifier: email.value.trim() });\n" +
    "      if (attempt.status === 'complete') {\n" +
    "        await c.setActive({ session: attempt.createdSessionId });\n" +
    "        window.location.href = target;\n" +
    "        return;\n" +
    "      }\n" +
    "      var factors = factorsOf(attempt);\n" +
    "      if (factors.indexOf('password') !== -1) {\n" +
    "        var withPass = await attempt.attemptFirstFactor({ strategy: 'password', password: password.value });\n" +
    "        if (withPass.status === 'complete') {\n" +
    "          await c.setActive({ session: withPass.createdSessionId });\n" +
    "          window.location.href = target;\n" +
    "          return;\n" +
    "        }\n" +
    "        if (withPass.status === 'needs_second_factor') {\n" +
    "          await withPass.prepareSecondFactor({ strategy: 'email_code' });\n" +
    "          showCodeStep(withPass);\n" +
    "          return;\n" +
    "        }\n" +
    "      }\n" +
    "      if (factors.indexOf('email_link') !== -1) {\n" +
    "        await attempt.attemptFirstFactor({ strategy: 'email_link', redirectUrl: target });\n" +
    "        msg.className = 'msg';\n" +
    "        msg.textContent = 'CHECK YOUR EMAIL — a sign-in link is on its way.';\n" +
    "        btn.disabled = true;\n" +
    "        btn.textContent = 'LINK SENT';\n" +
    "        return;\n" +
    "      }\n" +
    "      msg.className = 'msg msg--bad';\n" +
    "      msg.textContent = 'REQUIRED: ' + (attempt.status || 'additional factor');\n" +
    "    } catch (err) {\n" +
    "      msg.className = 'msg msg--bad';\n" +
    "      var errCode = (err && err.errors && err.errors[0]) ? err.errors[0].code : '';\n" +
    "      if (errCode === 'session_exists' || /session already exists/i.test(String(err && err.message))) { sessionAlreadyExists(); return; }\n" +
    "      var detail = (err && err.errors && err.errors[0]) ? (err.errors[0].long_message || err.errors[0].message) : (err && err.message ? err.message : 'sign in failed');\n" +
    "      msg.textContent = 'REFUSED — ' + detail;\n" +
    "    }\n" +
    "    btn.disabled = false;\n" +
    "    if (current && !codeWrap.classList.contains('hidden')) btn.textContent = 'VERIFY';\n" +
    "    else btn.textContent = 'SIGN IN';\n" +
    "  });\n" +
    "})();" +
    "</script>"
  );
}

// The /sso-callback bootstrap: Clerk redirected here after the provider flow
// finished. load clerk-js, let handleRedirectCallback swap the OAuth result for
// a session, then send the browser home. On failure (user cancelled, no OAuth
// app registered, etc.) fall back to the sign-in page.
function callbackScript(nonce, publishableKey, redirect) {
  return (
    '<script nonce="' + nonce + '">' +
    "(async function () {\n" +
    "  'use strict';\n" +
    "  var pub = " + JSON.stringify(publishableKey) + ";\n" +
    "  var root = window.location.origin + " + JSON.stringify(PREFIX) + ";\n" +
    "  var target = " + JSON.stringify(redirect || "") + " || root + '/';\n" +
    "  if (target.charAt(0) !== '/') target = root + '/';\n" +
    "  try {\n" +
    "    var c = await new Promise(function (resolve, reject) {\n" +
    "      (function wait() {\n" +
    "        if (window.Clerk) resolve(window.Clerk);\n" +
    "        else if (document.readyState === 'complete') reject(new Error('clerk-js did not load'));\n" +
    "        else setTimeout(wait, 100);\n" +
    "      })();\n" +
    "    });\n" +
    "    await c.load({ publishableKey: pub });\n" +
    "    await c.handleRedirectCallback({\n" +
    "      signInFallbackRedirectUrl: target,\n" +
    "      signUpFallbackRedirectUrl: target\n" +
    "    });\n" +
    "  } catch (err) {\n" +
    "    window.location.href = root + '/sign-in?redirect=' + encodeURIComponent(target);\n" +
    "  }\n" +
    "})();" +
    "</script>"
  );
}

export function signInPage({ publishableKey, nonce, redirect }) {
  const v = encodeURIComponent(ASSET_VERSION);
  const options = SSO_OPTIONS.map(
    (o) =>
      '<button type="button" class="btn btn--ghost si__sso hidden" data-strategy="' +
      o.strategy +
      '">' +
      o.label +
      "</button>",
  ).join("");
  const content =
    '<div class="panel">' +
    '<form id="si-form" novalidate>' +
    '<div class="tagline"><span class="tagline__box">identity</span></div>' +
    '<label class="si__label" for="si-email">email</label>' +
    '<input class="si__field" id="si-email" type="email" name="identifier" ' +
    'autocomplete="username" autocapitalize="none" spellcheck="false" required>' +
    '<label class="si__label" for="si-pass">password</label>' +
    '<input class="si__field" id="si-pass" type="password" name="password" ' +
    'autocomplete="current-password" required>' +
    '<div class="si__code hidden" id="si-code-wrap">' +
    '<label class="si__label" for="si-code">verification code</label>' +
    '<input class="si__field" id="si-code" type="text" name="code" inputmode="numeric" ' +
    'autocomplete="one-time-code" autocapitalize="none" spellcheck="false">' +
    "</div>" +
    '<button class="btn" id="si-submit" type="submit">SIGN IN</button>' +
    '<p class="msg hidden" id="si-msg"></p>' +
    "</form>" +
    '<div class="si__alt hidden" id="si-sso">' +
    '<div class="si__or" aria-hidden="true">or</div>' +
    '<div class="si__row">' +
    options +
    "</div>" +
    "</div>" +
    "</div>";

  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="dark">' +
    '<meta name="robots" content="noindex, nofollow">' +
    "<title>talvi — sign in</title>" +
    '<link rel="stylesheet" href="' + "/h.css?v=" + v + '">' +
    '<script nonce="' + nonce + '" defer src="' + CLERK_JS_URL + '" data-clerk-publishable-key="' + publishableKey + '"></script>' +
    "</head><body class=\"signin\">" +
    '<div class="scan" aria-hidden="true"></div>' +
    '<div class="leak" aria-hidden="true"></div>' +
    '<div class="grain" aria-hidden="true"></div>' +
    '<div class="wear" aria-hidden="true"></div>' +
    '<div class="frame"><div class="wrap">' +
    '<header class="head">' +
    '<h1 class="sign glitch"><a class="sign__link" href="' + PREFIX + '/">talvi</a></h1>' +
    '<div class="tagline"><span class="tagline__box">status</span></div>' +
    '<div class="box"><p class="lede glitch" data-type>' +
    "SESSION CLOSED. Sign in to drop a file. Sharing stays public — a link " +
    "already sent keeps working.</p></div>" +
    "</header>" +
    '<main class="stack">' +
    content +
    "</main>" +
    "</div></div>" +
    bootstrapScript(nonce, publishableKey, redirect) +
    "</body></html>"
  );
}

export function ssoCallbackPage({ publishableKey, nonce, redirect }) {
  const v = encodeURIComponent(ASSET_VERSION);
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="dark">' +
    '<meta name="robots" content="noindex, nofollow">' +
    "<title>talvi — sign in</title>" +
    '<link rel="stylesheet" href="' + "/h.css?v=" + v + '">' +
    '<script nonce="' + nonce + '" defer src="' + CLERK_JS_URL + '" data-clerk-publishable-key="' + publishableKey + '"></script>' +
    "</head><body class=\"signin\">" +
    '<div class="scan" aria-hidden="true"></div>' +
    '<div class="leak" aria-hidden="true"></div>' +
    '<div class="grain" aria-hidden="true"></div>' +
    '<div class="wear" aria-hidden="true"></div>' +
    '<div class="frame"><div class="wrap">' +
    '<header class="head">' +
    '<h1 class="sign glitch"><a class="sign__link" href="' + PREFIX + '/">talvi</a></h1>' +
    '<div class="tagline"><span class="tagline__box">status</span></div>' +
    '<div class="box"><p class="lede glitch" data-type>' +
    "COMPLETING SIGN-IN — one moment.</p></div>" +
    "</header>" +
    "</div></div>" +
    callbackScript(nonce, publishableKey, redirect) +
    "</body></html>"
  );
}
