/**
 * AppMates Community: get real testers for closed betas, get real users
 * for a launch or update. See `README.md` for the design rationale — in
 * particular why this never touches App Store/Play reviews or ratings.
 */

import { corsHeaders, error } from './lib/http.js';
import * as auth from './routes/auth.js';
import * as apps from './routes/apps.js';
import * as listings from './routes/listings.js';
import * as testSessions from './routes/testSessions.js';
import * as tokens from './routes/tokens.js';
import * as leaderboard from './routes/leaderboard.js';
import * as promo from './routes/promo.js';
import * as messages from './routes/messages.js';
import * as itunes from './routes/itunes.js';
import * as push from './routes/push.js';
import * as reports from './routes/reports.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env, request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Every branch is `await`ed, deliberately: returning an un-awaited
    // promise from inside this try block would let its eventual rejection
    // escape the catch below entirely (the implicit unwrap of a returned
    // thenable happens after the try/catch's dynamic scope has already
    // exited), surfacing as a raw platform error instead of a clean 500.
    try {
      if (path === '/auth/request-link' && method === 'POST') return await auth.requestLink(request, env);
      if (path === '/auth/verify' && method === 'GET') return await auth.verify(request, env);
      if (path === '/auth/logout' && method === 'POST') return await auth.logout(request, env);
      if (path === '/auth/me' && method === 'GET') return await auth.me(request, env);

      if (path === '/apps' && method === 'POST') return await apps.create(request, env);
      if (path === '/apps/mine' && method === 'GET') return await apps.mine(request, env);

      if (path === '/listings' && method === 'POST') return await listings.create(request, env);
      if (path === '/listings' && method === 'GET') return await listings.browse(request, env);
      if (path === '/listings/mine' && method === 'GET') return await listings.mine(request, env);

      let m;
      if ((m = path.match(/^\/listings\/([^/]+)\/close$/)) && method === 'POST') {
        return await listings.close(request, env, m[1]);
      }
      if ((m = path.match(/^\/listings\/([^/]+)\/feature$/)) && method === 'POST') {
        return await listings.feature(request, env, m[1]);
      }
      if ((m = path.match(/^\/listings\/([^/]+)\/request$/)) && method === 'POST') {
        return await listings.request(request, env, m[1]);
      }
      if ((m = path.match(/^\/listings\/([^/]+)\/sessions$/)) && method === 'GET') {
        return await listings.sessionsFor(request, env, m[1]);
      }
      // Must come after the exact-string and suffixed routes above, or it
      // would swallow every `/listings/:id/...` request as a listing id.
      if ((m = path.match(/^\/listings\/([^/]+)$/)) && method === 'GET') {
        return await listings.detail(request, env, m[1]);
      }

      if (path === '/test-sessions/mine' && method === 'GET') return await testSessions.mine(request, env);
      if ((m = path.match(/^\/test-sessions\/([^/]+)\/accept$/)) && method === 'POST') {
        return await testSessions.accept(request, env, m[1]);
      }
      if ((m = path.match(/^\/test-sessions\/([^/]+)\/decline$/)) && method === 'POST') {
        return await testSessions.decline(request, env, m[1]);
      }
      if ((m = path.match(/^\/test-sessions\/([^/]+)\/submit$/)) && method === 'POST') {
        return await testSessions.submit(request, env, m[1]);
      }
      if ((m = path.match(/^\/test-sessions\/([^/]+)\/complete$/)) && method === 'POST') {
        return await testSessions.complete(request, env, m[1]);
      }
      if ((m = path.match(/^\/test-sessions\/([^/]+)\/messages$/)) && method === 'GET') {
        return await messages.list(request, env, m[1]);
      }
      if ((m = path.match(/^\/test-sessions\/([^/]+)\/messages$/)) && method === 'POST') {
        return await messages.send(request, env, m[1], ctx);
      }
      if ((m = path.match(/^\/test-sessions\/([^/]+)\/report$/)) && method === 'POST') {
        return await messages.report(request, env, m[1]);
      }
      if ((m = path.match(/^\/test-sessions\/([^/]+)\/mute$/)) && method === 'POST') {
        return await messages.mute(request, env, m[1]);
      }
      if ((m = path.match(/^\/test-sessions\/([^/]+)\/unmute$/)) && method === 'POST') {
        return await messages.unmute(request, env, m[1]);
      }
      if (path === '/test-sessions/muted' && method === 'GET') return await messages.mutedSessions(request, env);

      if (path === '/push/subscribe' && method === 'POST') return await push.subscribe(request, env);
      if (path === '/push/unsubscribe' && method === 'POST') return await push.unsubscribe(request, env);
      if (path === '/push/test-session' && method === 'GET') return await push.testSession(request, env);

      if (path === '/reports' && method === 'GET') return await reports.adminList(request, env);

      if (path === '/tokens/me' && method === 'GET') return await tokens.me(request, env);
      if (path === '/leaderboard' && method === 'GET') return await leaderboard.top(request, env);

      if (path === '/promo/requests' && method === 'POST') return await promo.create(request, env);
      if (path === '/promo/requests' && method === 'GET') return await promo.adminList(request, env);
      if ((m = path.match(/^\/promo\/requests\/([^/]+)\/(approve|reject)$/)) && method === 'POST') {
        return await promo.adminReview(request, env, m[1], m[2]);
      }
      if (path === '/promo/featured' && method === 'GET') return await promo.featured(request, env);

      if (path === '/itunes/lookup' && method === 'GET') return await itunes.lookup(request, env, ctx);
      if (path === '/itunes/search' && method === 'GET') return await itunes.search(request, env, ctx);

      return error(env, request, 404, 'not found');
    } catch (err) {
      console.error(err);
      return error(env, request, 500, 'internal error');
    }
  },

  // Fires on the cron schedule in wrangler.jsonc's `triggers.crons` —
  // the 48-hour email fallback for unseen reports (`escalateUnseenReports`
  // in routes/reports.js). Nothing else on a schedule yet.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(reports.escalateUnseenReports(env).catch((err) => console.error('report escalation run failed', err)));
  },
};
