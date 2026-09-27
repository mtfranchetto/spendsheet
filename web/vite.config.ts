/**
 * vite.config.ts
 *
 * Two things here are decisions rather than defaults.
 *
 * **`build.rollupOptions` is left alone and no CDN appears anywhere.** Every
 * dependency is installed, bundled and served from our own origin, and it is
 * the reason the sign-in flow is a redirect rather than the Google Identity
 * Services button, which would have needed a script tag pointing at
 * `accounts.google.com`. See `worker/oauth.ts`.
 *
 * **The dev server proxies the Worker's paths to `wrangler dev`.** In production the
 * page and the API are one origin, which is the whole architecture: a
 * server-set first-party cookie is what escapes ITP's seven-day cap, and an API
 * on a different registrable domain would make us third party again. Proxying
 * in dev means the browser sees one origin there too, so cookie behaviour under
 * test is the cookie behaviour that ships — rather than something that works
 * locally and fails on the phone.
 */

import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],

  server: {
    port: 4322,
    // `wrangler dev` on 8787 runs the Worker. Started separately — one process
    // per job, so a crashed Worker does not take the page with it and the logs
    // stay readable. Every path the Worker owns in production is proxied, so
    // the browser sees one origin here exactly as it does deployed.
    proxy: Object.fromEntries(
      ['/api', '/auth', '/connect'].map((path) => [path, { target: 'http://127.0.0.1:8787', changeOrigin: false }])
    )
  },

  build: {
    target: 'es2022',
    sourcemap: true,

    // A private app for one person; there is nothing to obscure and a readable
    // stack trace from the phone is worth more than a few kilobytes.
    minify: 'esbuild'
  }
});
