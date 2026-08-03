import { json, error } from '../lib/http.js';
import { currentUser, isAdmin } from '../lib/auth.js';
import { sendEmail } from '../lib/email.js';

/**
 * Every report, newest first, for manual review by an admin — nothing here
 * is actioned automatically, this is purely a queue for a human to read.
 * `target_type = 'session'` is the only kind anything currently creates
 * (see `messages.report`); the LEFT JOIN degrades to nulls for any other
 * kind rather than requiring one, since `reports` was designed to cover
 * listings and users too even though nothing reports those yet.
 */
export async function adminList(request, env) {
  const user = await currentUser(env, request);
  if (!isAdmin(env, user)) return error(env, request, 403, 'admin access required');

  const { results } = await env.DB.prepare(
    `SELECT r.id, r.target_type, r.target_id, r.reason, r.created_at,
            reporter.email AS reporter_email,
            a.name AS app_name,
            tester.email AS tester_email,
            owner.email AS owner_email
     FROM reports r
     JOIN users reporter ON reporter.id = r.reporter_user_id
     LEFT JOIN test_sessions ts ON r.target_type = 'session' AND ts.id = r.target_id
     LEFT JOIN listings l ON l.id = ts.listing_id
     LEFT JOIN apps a ON a.id = l.app_id
     LEFT JOIN users tester ON tester.id = ts.tester_user_id
     LEFT JOIN users owner ON owner.id = l.owner_user_id
     ORDER BY r.created_at DESC
     LIMIT 200`,
  ).all();

  return json(env, request, {
    reports: results.map((r) => ({
      id: r.id,
      targetType: r.target_type,
      targetId: r.target_id,
      reason: r.reason,
      createdAt: r.created_at,
      reporterEmail: r.reporter_email,
      appName: r.app_name,
      testerEmail: r.tester_email,
      ownerEmail: r.owner_email,
    })),
  });
}

/**
 * The one alert the admin allowlist actually gets pushed, rather than
 * having to remember to check `#admin` — same `ADMIN_EMAILS` parsing as
 * `isAdmin` in lib/auth.js. Called from `messages.report` right after the
 * `reports` row is inserted; failures are logged by the caller and never
 * block the reporter's own request, the same "backgrounded, best-effort"
 * treatment every push notification in this app already gets.
 */
export async function notifyAdminsOfReport(env, { reporterEmail, appName, reason }) {
  const admins = (env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (!admins.length) return;

  const html = `
    <p><strong>${escapeHtml(reporterEmail)}</strong> reported a conversation about
    <strong>${escapeHtml(appName || 'an app')}</strong>.</p>
    <p>${escapeHtml(reason)}</p>
    <p><a href="${env.APP_ORIGIN}${env.APP_PATH}#admin">Open the admin inbox</a></p>`;
  const text = `${reporterEmail} reported a conversation about ${appName || 'an app'}.\n\n${reason}\n\n${env.APP_ORIGIN}${env.APP_PATH}#admin`;

  await Promise.all(
    admins.map((to) => sendEmail(env, { to, subject: 'AppMates — conversation reported', html, text })),
  );
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
