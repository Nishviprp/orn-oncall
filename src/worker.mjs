// ORN Global ON CALL – Cloudflare Worker entry point.
// Serves the page from /public, answers /api/oncall/*, and runs reminders on a schedule.
import { setEnv } from './lib.mjs';
import { handleApi } from './routes.mjs';
import { runReminders } from './reminders.mjs';

export default {
  async fetch(request, env) {
    setEnv(env);
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/oncall/')) return handleApi(request);

    // Stand-alone deploy: the home page goes to ON CALL.
    if (url.pathname === '/' && String(env.REDIRECT_HOME ?? 'true') !== 'false') {
      return Response.redirect(new URL('/oncall/', url).toString(), 302);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    setEnv(env);
    ctx.waitUntil(runReminders(new Date(event.scheduledTime || Date.now())));
  },
};
