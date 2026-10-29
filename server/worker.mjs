import { cleanupRevokedSubscriptions, createSubscriptionHandler } from "./subscriptions.mjs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/sub/")) {
      return createSubscriptionHandler({ kv: env.SUBSCRIPTIONS })(request);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanupRevokedSubscriptions(env.SUBSCRIPTIONS));
  },
};
