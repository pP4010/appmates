import { json, error } from '../lib/http.js';
import { currentUser, isAdmin } from '../lib/auth.js';

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
