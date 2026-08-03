import { json, error } from '../lib/http.js';
import { currentUser, isAdmin } from '../lib/auth.js';
import { sendEmail } from '../lib/email.js';
import { REPORT_ESCALATION_HOURS } from '../lib/config.js';

const REPORT_SELECT = `
  SELECT r.id, r.target_type, r.target_id, r.cause, r.reason, r.created_at, r.seen_at,
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
  LEFT JOIN users owner ON owner.id = l.owner_user_id`;

function serialize(r) {
  return {
    id: r.id,
    targetType: r.target_type,
    targetId: r.target_id,
    cause: r.cause,
    reason: r.reason,
    createdAt: r.created_at,
    reporterEmail: r.reporter_email,
    appName: r.app_name,
    testerEmail: r.tester_email,
    ownerEmail: r.owner_email,
  };
}

/**
 * Every report, newest first, for manual review by an admin — nothing here
 * is actioned automatically, this is purely a queue for a human to read.
 * `target_type = 'session'` is the only kind anything currently creates
 * (see `messages.report`); the LEFT JOIN degrades to nulls for any other
 * kind rather than requiring one, since `reports` was designed to cover
 * listings and users too even though nothing reports those yet.
 *
 * Opening this list *is* "seen" — every report still unseen at the moment
 * of this call gets `seen_at` stamped before the response goes out, which
 * is what stops `escalateUnseenReports` from ever mailing about one you've
 * already looked at. `wasNew` reflects the state as read, before that
 * update — so the client can still show "new" for this one visit.
 */
export async function adminList(request, env) {
  const user = await currentUser(env, request);
  if (!isAdmin(env, user)) return error(env, request, 403, 'admin access required');

  const { results } = await env.DB.prepare(`${REPORT_SELECT} ORDER BY r.created_at DESC LIMIT 200`).all();

  await env.DB.prepare("UPDATE reports SET seen_at = datetime('now') WHERE seen_at IS NULL").run();

  return json(env, request, {
    reports: results.map((r) => ({ ...serialize(r), wasNew: r.seen_at === null })),
  });
}

/**
 * The immediate half of report alerting is a push (`notifyAdminsOfReportPush`
 * in lib/push.js) — this is the fallback, only reached by
 * `escalateUnseenReports` below when nobody opened `#admin` to mark it
 * seen within `REPORT_ESCALATION_HOURS`. Deliberately not called from
 * `messages.report` directly anymore: the whole point of the two-tier
 * design is that a report that gets seen quickly never generates an email
 * at all.
 */
async function notifyAdminsOfReportEmail(env, { reporterEmail, appName, reason }) {
  const admins = (env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (!admins.length) return;

  const html = `
    <p>A report from ${Math.round(REPORT_ESCALATION_HOURS)}+ hours ago is still unseen in the admin inbox.</p>
    <p><strong>${escapeHtml(reporterEmail)}</strong> reported a conversation about
    <strong>${escapeHtml(appName || 'an app')}</strong>.</p>
    <p>${escapeHtml(reason)}</p>
    <p><a href="${env.APP_ORIGIN}${env.APP_PATH}#admin">Open the admin inbox</a></p>`;
  const text =
    `A report from ${Math.round(REPORT_ESCALATION_HOURS)}+ hours ago is still unseen in the admin inbox.\n\n` +
    `${reporterEmail} reported a conversation about ${appName || 'an app'}.\n\n${reason}\n\n` +
    `${env.APP_ORIGIN}${env.APP_PATH}#admin`;

  await Promise.all(
    admins.map((to) => sendEmail(env, { to, subject: 'AppMates — unseen report needs attention', html, text })),
  );
}

/**
 * Runs on the Worker's cron trigger (see `scheduled` in index.js, and
 * `triggers.crons` in wrangler.jsonc) — finds every report nobody has
 * opened `#admin` to see within `REPORT_ESCALATION_HOURS` of it landing,
 * emails the admin allowlist about each, and stamps `escalated_at` so the
 * same report never mails twice even if this job runs again before
 * someone finally looks.
 */
export async function escalateUnseenReports(env) {
  const { results } = await env.DB.prepare(
    `${REPORT_SELECT}
     WHERE r.seen_at IS NULL AND r.escalated_at IS NULL
       AND r.created_at < datetime('now', ?)
     ORDER BY r.created_at ASC`,
  )
    .bind(`-${REPORT_ESCALATION_HOURS} hours`)
    .all();

  for (const r of results) {
    try {
      await notifyAdminsOfReportEmail(env, { reporterEmail: r.reporter_email, appName: r.app_name, reason: r.reason });
      await env.DB.prepare("UPDATE reports SET escalated_at = datetime('now') WHERE id = ?").bind(r.id).run();
    } catch (err) {
      // Left un-escalated on failure, deliberately — the next cron run
      // retries it rather than silently dropping the alert.
      console.error('report escalation email failed', r.id, err);
    }
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
