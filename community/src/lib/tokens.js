import { newId } from './http.js';

export class InsufficientTokensError extends Error {}

const VALID_REASONS = new Set(['earned_test', 'spent_feature', 'refund', 'adjustment']);

/**
 * Applies a token delta atomically: one ledger row plus the cached balance
 * update, in a single D1 batch so a crash between the two can never happen.
 * `delta` may be negative (spending) — callers never write `token_balance`
 * directly, only through here, so the ledger stays the single source of
 * truth the balance is derived from.
 *
 * `extraStatements` join the same batch — so the state change a token
 * movement is *for* (marking a test session completed, extending a
 * listing's `featured_until`) commits or fails together with the ledger
 * entry. Passing that as a follow-up statement outside the batch was the
 * original shape here, and it had a real failure mode: if the ledger write
 * succeeded but the follow-up threw, the token was spent or awarded with
 * nothing to show for it, and no way to retry (the status guard that
 * prevents double-awarding also blocks the retry).
 */
async function applyDelta(env, userId, delta, reason, relatedId, extraStatements = []) {
  if (!VALID_REASONS.has(reason)) throw new Error(`invalid ledger reason: ${reason}`);

  const id = newId();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO token_ledger (id, user_id, delta, reason, related_id) VALUES (?, ?, ?, ?, ?)',
    ).bind(id, userId, delta, reason, relatedId ?? null),
    env.DB.prepare('UPDATE users SET token_balance = token_balance + ? WHERE id = ?').bind(
      delta,
      userId,
    ),
    ...extraStatements,
  ]);
}

/** Awarded only by a listing owner confirming a tester actually helped —
 * see routes/testSessions.js. Never self-service. `extraStatements` lets the
 * caller land its own state change (e.g. marking the session `completed`)
 * in the same atomic batch as the award — see `applyDelta`. */
export async function awardTokens(env, userId, amount, reason, relatedId, extraStatements = []) {
  if (amount <= 0) throw new Error('award amount must be positive');
  await applyDelta(env, userId, amount, reason, relatedId, extraStatements);
}

/**
 * Spends tokens, checked and deducted atomically against the *authoritative*
 * ledger sum (not the cached column) so a race between two spends from the
 * same user can't both succeed and overdraw the balance. `extraStatements`
 * lets the caller land what the spend paid for (e.g. extending a listing's
 * `featured_until`) in the same atomic batch as the deduction — see
 * `applyDelta`.
 */
export async function spendTokens(env, userId, amount, reason, relatedId, extraStatements = []) {
  if (amount <= 0) throw new Error('spend amount must be positive');

  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(delta), 0) AS balance FROM token_ledger WHERE user_id = ?',
  )
    .bind(userId)
    .first();
  if ((row?.balance ?? 0) < amount) throw new InsufficientTokensError();

  await applyDelta(env, userId, -amount, reason, relatedId, extraStatements);
}

export async function tokenHistory(env, userId, limit = 50) {
  const { results } = await env.DB.prepare(
    'SELECT id, delta, reason, related_id, created_at FROM token_ledger ' +
      'WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
  )
    .bind(userId, limit)
    .all();
  return results.map((r) => ({
    id: r.id,
    delta: r.delta,
    reason: r.reason,
    relatedId: r.related_id,
    createdAt: r.created_at,
  }));
}
