/**
 * The only file in the API that knows it is running on Cloudflare.
 *
 * Everything else is `(Request, Env, nowSeconds) => Response` over standard Web
 * APIs, which is what lets the whole surface be tested under plain Vitest with
 * no emulator. Keep this adapter this short: anything that grows here is
 * something the tests stop being able to reach.
 *
 * `[[path]]` is Pages' catch-all, so one function answers every `/api/*` route
 * and the routing table lives in one readable place rather than in a directory
 * layout.
 */

import { handle, type Env } from '../lib/router';

export const onRequest = (context: { request: Request; env: Env }): Promise<Response> =>
  handle(context.request, context.env, Math.floor(Date.now() / 1000));
