/**
 * The entry point, and the shortest file here on purpose.
 *
 * `render` takes a *function* returning the component rather than an element,
 * because Solid's reactivity is established when the root runs — handing it an
 * already-evaluated `<App />` would evaluate outside the root's tracking scope.
 * It is the same run-once trap as reading a signal into a plain variable,
 * wearing its entry-point clothes.
 */

import { render } from '@solidjs/web';
import App from './app/App';
import { start } from './app/state';
import { refuseZoom } from './app/zoom';

const root = document.getElementById('root');
if (!root) throw new Error('main: #root is missing from index.html');

refuseZoom(document);
render(() => <App />, root);
void start();

// Built pages only: under `vite` the shell changes on every save, and a worker
// serving yesterday's copy of it is a debugging session nobody asked for.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // No worker is a page that needs the network to open, which is every page
    // before this one.
  });
}
