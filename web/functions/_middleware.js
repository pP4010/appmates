/**
 * Private-preview gate for the whole Pages site — runs in front of every
 * request (`functions/_middleware.js` is Cloudflare Pages' catch-all
 * convention, no route config needed).
 *
 * Exists because Cloudflare Access (the "real" way to do this) isn't
 * reachable with this deployment's API token — the same permission gap
 * hit earlier with Email Sending. This needs no extra Cloudflare
 * permissions at all: it's just a Pages Function, deployed the same way
 * as the site itself.
 *
 * Two secrets, not one: `SITE_PASSWORD` is what a human types; `GATE_KEY`
 * is a separate random value used as the cookie's contents. Keeping them
 * distinct means the password itself never sits in a browser cookie —
 * only this unrelated token does, so rotating the password later doesn't
 * require finding and clearing everyone's existing cookie.
 */

const COOKIE_NAME = 'appmates_gate';

// Constant-time compare via SHA-256 digests (fixed 32-byte length either
// side, so no early-exit on length or byte position leaks timing about the
// real password).
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

function loginPage(wrongPassword) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AppMates — Private preview</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b0b0f; color: #f0f0f4;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
  }
  form {
    background: #151519; border: 1px solid #26262f; border-radius: 14px;
    padding: 2rem; width: 100%; max-width: 20rem; box-sizing: border-box;
  }
  h1 { font-size: 1rem; margin: 0 0 .3rem; }
  p.sub { color: #83838f; font-size: .82rem; margin: 0 0 1.2rem; }
  input {
    width: 100%; box-sizing: border-box; padding: .6rem .75rem; border-radius: 8px;
    border: 1px solid #34343f; background: #1c1c22; color: #f0f0f4; font: inherit; margin-bottom: .9rem;
  }
  button {
    width: 100%; padding: .65rem; border-radius: 8px; border: none; cursor: pointer;
    background: linear-gradient(140deg, #8b8ef5, #a0a3ff); color: #14142a; font: inherit; font-weight: 650;
  }
  p.error { color: #fb7185; font-size: .82rem; margin: -.4rem 0 .9rem; }
</style>
</head>
<body>
  <form method="POST" action="/_gate">
    <h1>AppMates</h1>
    <p class="sub">This site is private while it's being finished.</p>
    ${wrongPassword ? '<p class="error">Wrong password — try again.</p>' : ''}
    <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
    <button type="submit">Enter</button>
  </form>
</body>
</html>`;
}

function hasValidCookie(request, env) {
  const header = request.headers.get('cookie') || '';
  return header
    .split(';')
    .map((c) => c.trim())
    .some((c) => c === `${COOKIE_NAME}=${env.GATE_KEY}`);
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (url.pathname === '/_gate' && request.method === 'POST') {
    const form = await request.formData();
    const submitted = form.get('password');

    if (submitted && (await timingSafeEqual(submitted, env.SITE_PASSWORD))) {
      return new Response(null, {
        status: 302,
        headers: {
          location: '/',
          'set-cookie':
            `${COOKIE_NAME}=${env.GATE_KEY}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
        },
      });
    }
    return new Response(loginPage(true), { status: 401, headers: { 'content-type': 'text/html' } });
  }

  if (hasValidCookie(request, env)) return next();

  return new Response(loginPage(false), { status: 401, headers: { 'content-type': 'text/html' } });
}
