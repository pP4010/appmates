import { json, error, sessionCookieHeader, readSessionToken } from '../lib/http.js';
import {
  isValidEmail,
  issueMagicLink,
  sendMagicLinkEmail,
  consumeMagicLink,
  getOrCreateUser,
  createSession,
  destroySession,
  currentUser,
  serializeUser,
} from '../lib/auth.js';

export async function requestLink(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return error(env, request, 400, 'expected JSON body');
  }

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!isValidEmail(email)) return error(env, request, 400, 'a valid email is required');

  const token = await issueMagicLink(env, email);
  const devMode = env.DEV_EXPOSE_LINKS === 'true';

  // Rate-limited or not, the response is identical — never reveal which,
  // that would just be a probe signal for an attacker.
  if (token && !devMode) {
    await sendMagicLinkEmail(env, email, token);
  }

  // Local-dev-only escape hatch: `.dev.vars` sets this, production config
  // never does, so a real deploy can never leak a sign-in link in the API
  // response or skip actually emailing it. Lets the flow be tested end to
  // end before a domain is onboarded for Email Sending.
  if (devMode && token) {
    return json(env, request, { ok: true, devToken: token });
  }

  return json(env, request, { ok: true });
}

export async function verify(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';

  const email = await consumeMagicLink(env, token);
  if (!email) {
    return new Response('This sign-in link is invalid or has expired. Request a new one.', {
      status: 400,
      headers: { 'content-type': 'text/plain' },
    });
  }

  const user = await getOrCreateUser(env, email);
  const session = await createSession(env, user.id);

  const redirectTo = `${env.APP_ORIGIN}/#community`;
  return new Response(null, {
    status: 302,
    headers: {
      location: redirectTo,
      'set-cookie': sessionCookieHeader(request, session.token, {
        maxAgeSeconds: session.maxAgeSeconds,
      }),
    },
  });
}

export async function logout(request, env) {
  const token = readSessionToken(request);
  await destroySession(env, token);
  return json(
    env,
    request,
    { ok: true },
    { headers: { 'set-cookie': sessionCookieHeader(request, '') } },
  );
}

export async function me(request, env) {
  const user = await currentUser(env, request);
  if (!user) return error(env, request, 401, 'not signed in');
  return json(env, request, { user: serializeUser(user) });
}
