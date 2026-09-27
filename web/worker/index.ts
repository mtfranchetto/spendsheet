/**
 * The only file in the Worker that knows it is running on Cloudflare.
 *
 * Everything else is `(Request, Env, nowSeconds) => Response` over standard Web
 * APIs, which is what lets the whole surface be tested under plain Vitest — and
 * what makes moving hosts a redeploy rather than a rewrite. Keep this short:
 * anything that grows here is something the tests stop being able to reach.
 */

import { handle, type Env } from './router';

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, Math.floor(Date.now() / 1000));
  }
};
