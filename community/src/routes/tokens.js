import { json, error } from '../lib/http.js';
import { currentUser } from '../lib/auth.js';
import { tokenHistory } from '../lib/tokens.js';

export async function me(request, env) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'sign in required');

  const history = await tokenHistory(env, user.id);
  return json(env, request, { balance: user.token_balance, history });
}
