/**
 * The entry point, and the shortest file here on purpose.
 *
 * `render` takes a *function* returning the component rather than an element,
 * because Solid's reactivity is established when the root runs — handing it an
 * already-evaluated `<App />` would evaluate outside the root's tracking scope.
 * It is the same run-once trap as reading a signal into a plain variable,
 * wearing its entry-point clothes.
 */

import { render } from 'solid-js/web';
import App from './app/App';

const root = document.getElementById('root');
if (!root) throw new Error('main: #root is missing from index.html');

render(() => <App />, root);
