import { newId, readSessionToken } from './http.js';
import { sendEmail } from './email.js';

const MAGIC_LINK_TTL_MINUTES = 15;
const SESSION_TTL_DAYS = 30;
const MAX_LINK_REQUESTS_PER_WINDOW = 5;
const LINK_REQUEST_WINDOW_MINUTES = 15;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

/** True if this email has requested too many links recently — cheap abuse
 * guard against using the mailer to spam an inbox or burn sending quota.
 *
 * The cutoff is computed with SQLite's own `datetime('now', ...)` rather
 * than a JS `Date#toISOString()` value: the two formats (`T`-separated with
 * a `Z` vs SQLite's space-separated text) sort differently as plain text,
 * so comparing one against the other silently never matches. Every
 * timestamp compared in SQL anywhere in this file is computed in SQL for
 * exactly that reason. */
async function isRateLimited(env, email) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM magic_link_requests
     WHERE email = ? AND requested_at > datetime('now', ?)`,
  )
    .bind(email, `-${LINK_REQUEST_WINDOW_MINUTES} minutes`)
    .first();
  return (row?.n ?? 0) >= MAX_LINK_REQUESTS_PER_WINDOW;
}

/** Creates a magic link token and records the request for rate limiting.
 * Returns `null` (not an error) when rate-limited, so the caller can still
 * answer with a generic "check your inbox" — never reveal the limit itself
 * to avoid handing an attacker a probe signal. */
export async function issueMagicLink(env, email) {
  if (await isRateLimited(env, email)) return null;

  const token = newId();

  await env.DB.batch([
    env.DB.prepare('INSERT INTO magic_link_requests (email) VALUES (?)').bind(email),
    env.DB.prepare(
      "INSERT INTO magic_links (token, email, expires_at) VALUES (?, ?, datetime('now', ?))",
    ).bind(token, email, `+${MAGIC_LINK_TTL_MINUTES} minutes`),
  ]);

  return token;
}

/** Sent via `sendEmail` (Resend's HTTP API), not the Workers `send_email`
 * binding — that binding only reaches Cloudflare's "Email Sending"
 * product, which is paid-tier only. */
export async function sendMagicLinkEmail(env, email, token) {
  const verifyUrl = new URL('/auth/verify', selfOrigin(env)).toString() + `?token=${token}`;
  const html = `
    <p>Click to sign in to AppMates Community:</p>
    <p><a href="${verifyUrl}">${verifyUrl}</a></p>
    <p>This link expires in ${MAGIC_LINK_TTL_MINUTES} minutes and can only be used once.
    If you didn't request this, ignore this email.</p>`;
  const text = `Sign in to AppMates Community: ${verifyUrl}\n\n` +
    `This link expires in ${MAGIC_LINK_TTL_MINUTES} minutes and can only be used once. ` +
    "If you didn't request this, ignore this email.";

  await sendEmail(env, { to: email, subject: 'Sign in to AppMates', html, text });
}

/** Where the Worker itself is reachable — the link Apple/Google-style
 * clients open is `/auth/verify` on this Worker (which then redirects into
 * the web app), not the web app's own origin. */
function selfOrigin(env) {
  return env.WORKER_ORIGIN || 'http://localhost:8788';
}

/** Consumes a magic link (single use) and returns the email it was issued
 * to, or `null` if the token is unknown, expired, or already used. The
 * expiry check happens in the same statement, in SQL, for the same reason
 * noted on `isRateLimited`. */
export async function consumeMagicLink(env, token) {
  const row = await env.DB.prepare(
    `SELECT email FROM magic_links
     WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')`,
  )
    .bind(token)
    .first();
  if (!row) return null;

  await env.DB.prepare('UPDATE magic_links SET used_at = datetime(\'now\') WHERE token = ?')
    .bind(token)
    .run();
  return row.email;
}

/** Finds the user for an email, creating one on first sign-in. */
export async function getOrCreateUser(env, email) {
  const existing = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (existing) return existing;

  const id = newId();
  await env.DB.prepare('INSERT INTO users (id, email) VALUES (?, ?)').bind(id, email).run();
  return { id, email, display_name: null, token_balance: 0, banned_at: null };
}

export async function createSession(env, userId) {
  const token = newId();
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))",
  )
    .bind(token, userId, `+${SESSION_TTL_DAYS} days`)
    .run();
  return { token, maxAgeSeconds: SESSION_TTL_DAYS * 86_400 };
}

export async function destroySession(env, token) {
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

/** Resolves the authenticated user from the request's session cookie, or
 * `null`. Expired sessions are treated as absent rather than cleaned up
 * inline — a lazy sweep keeps this path simple and read-only. */
export async function currentUser(env, request) {
  const token = readSessionToken(request);
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`,
  )
    .bind(token)
    .first();
  if (!row || row.banned_at) return null;
  return row;
}

export function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    tokenBalance: user.token_balance,
  };
}

/**
 * Whether this signed-in user may see/manage the admin inbox (promoted-slot
 * approvals today). A comma-separated allowlist in `env.ADMIN_EMAILS`
 * rather than a `users.role` column — the set of people this needs to cover
 * is one person right now, and a migration plus a role-management UI would
 * be more code than the feature it protects. Revisit if that ever changes.
 */
export function isAdmin(env, user) {
  if (!user) return false;
  const allowlist = (env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowlist.includes(user.email.toLowerCase());
}
