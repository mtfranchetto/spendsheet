/**
 * App.tsx — the shell: who you are, which screen, and the strips around it.
 *
 * Signed out, refused, unreachable and "choose the book" are the thin slice's
 * screens, kept as they were, because each is a state the device checks
 * proved and a test holds. Signed in, it is the Apps Script viewer's three
 * screens and its tab bar, drawn from the book `state.ts` holds.
 *
 * ## The Solid 2 rules that fail quietly
 *
 * A component body runs once, and reading a signal there freezes it: derived
 * values live in JSX or a memo. Props are values, never destructured. A
 * setter's value is seen after the microtask, and nothing reactive may write
 * a signal — writes happen in handlers and in `state.ts`'s async code, which
 * runs outside any owner.
 */

import { createEffect, createSignal, For, Match, onSettled, Show, Switch } from 'solid-js';
import { api, goConnect, goSignIn, type RefusedAccount } from '../api/client';
import { admitCommand } from '../admit';
import { agoWords } from './format';
import { AddCash, SetValue } from './Add';
import { Analytics } from './Analytics';
import { Dashboard } from './Dashboard';
import { installPullToRefresh } from './pull';
import { Records } from './Records';
import { SheetHost } from './Sheet';
import {
  go, held, noAccess, pullToRefresh, pulled, readFailed, reading, refresh, session, signOut, toastText, view
} from './state';
import { viewSearch, type Screen } from './view';

/** What the last navigation said about signing in or connecting. Read once, before the URL is rewritten: it describes the past. */
const params = new URLSearchParams(window.location.search);
const arrived = { signin: params.get('signin'), connected: params.get('connected'), connect: params.get('connect') };

const TABS: { id: Screen; label: string; glyph: string }[] = [
  { id: 'dashboard', label: 'Home', glyph: '\u{1F3E0}' },
  { id: 'records', label: 'Records', glyph: '\u{1F4C4}' },
  { id: 'analytics', label: 'Charts', glyph: '\u{1F4CA}' }
];

/** The refusal notice. Who was refused comes from the Worker's sealed cookie, never the URL. */
function Refused() {
  const [who, setWho] = createSignal<RefusedAccount | null>(null);
  onSettled(() => {
    void api.refused().then((account) => setWho(account));
  });
  const command = () => admitCommand(who());
  return (
    <div class="notice">
      <p>
        <Show when={who()} fallback="That Google account">
          {(account) => <strong>{account().email}</strong>}
        </Show>{' '}
        is not on this viewer's list.
      </p>
      <Show when={command()}>
        {(line) => (
          <>
            <p>To be let in, send this to whoever runs the viewer. They run it in <code>web/</code>, and you sign in again:</p>
            <pre>{line()}</pre>
            <button type="button" onClick={() => navigator.clipboard?.writeText(line())}>
              Copy command
            </button>
          </>
        )}
      </Show>
    </div>
  );
}

function Arrived() {
  return (
    <>
      <Show when={arrived.signin === 'refused'}>
        <Refused />
      </Show>
      <Show when={arrived.signin === 'state' || arrived.signin === 'failed'}>
        <p class="notice">Sign-in did not complete. Try again.</p>
      </Show>
      {/* Until the first fresh read lands: after that it would be claiming work that is done. */}
      <Show when={arrived.connected === '1' && !(held() && !held()!.fromCache)}>
        <p class="notice">Book chosen. Reading it…</p>
      </Show>
      <Show when={arrived.connect === 'unavailable'}>
        <p class="notice">Google did not answer. Try choosing the book again in a moment.</p>
      </Show>
    </>
  );
}

/** Signed in: the book on screen, or why it is not. */
function SignedIn(props: { email: string }) {
  return (
    <Switch
      fallback={
        <>
          <Show when={readFailed() && held()?.fromCache}>
            <div class="banner warn">
              <div>Could not reach the book. This is the last copy this phone kept, from {agoWords(held()!.savedAt, Date.now())}.</div>
            </div>
          </Show>
          <Show when={noAccess()}>
            <div class="banner warn">
              <div>The viewer cannot read the book right now. This is the last copy this phone kept.</div>
              <button type="button" class="link" onClick={goConnect}>
                Choose the book
              </button>
            </div>
          </Show>
          <Switch>
            <Match when={view().screen === 'records'}>
              <Records />
            </Match>
            <Match when={view().screen === 'analytics'}>
              <Analytics />
            </Match>
            <Match when={view().screen === 'add'}>
              <AddCash />
            </Match>
            <Match when={view().screen === 'value'}>
              <SetValue />
            </Match>
            <Match when={view().screen === 'dashboard'}>
              <Dashboard />
              <footer class="muted">
                <span>Signed in as {props.email}. </span>
                <button type="button" class="link" onClick={() => void signOut()}>
                  Sign out
                </button>
              </footer>
            </Match>
          </Switch>
        </>
      }
    >
      <Match when={!held() && noAccess()}>
        <h1>Spendsheet</h1>
        <p>The viewer cannot read your book yet.</p>
        <button type="button" onClick={goConnect}>
          Choose the book
        </button>
      </Match>
      <Match when={!held() && readFailed()}>
        <h1>Spendsheet</h1>
        <div class="banner bad">Could not reach the book.</div>
        <button type="button" onClick={() => void refresh()}>
          Try again
        </button>
      </Match>
    </Switch>
  );
}

export default function App() {
  let pullNode: HTMLDivElement | undefined;

  // The address is the view, always — replaced, never pushed, so Back leaves the app rather than stepping through filters.
  createEffect(
    () => viewSearch(view()),
    (search) => {
      if (window.location.search !== search) window.history.replaceState(null, '', window.location.pathname + search);
    }
  );

  // Bound once to the document, so no redraw can take it.
  onSettled(() => {
    if (!pullNode) return;
    return installPullToRefresh(pullNode, pullToRefresh, reading);
  });

  const signedIn = () => {
    const current = session();
    return current.kind === 'in' ? current.me : null;
  };

  /*
    "What you are looking at is the last copy, not a fresh one." Up while a
    read is out **and** the screen is the stored copy — a cold open has a
    spinner already, and two indicators for one wait read as two things. A
    pull always earns it: the screen behind it is live, and nothing else
    would say the gesture was received.
  */
  const strip = () => reading() && (!!held()?.fromCache || pulled());
  const stripText = () => {
    const h = held();
    return h && h.fromCache ? 'Last updated ' + agoWords(h.savedAt, Date.now()) : 'Refreshing';
  };

  return (
    <>
      <div id="refresh" role="status" hidden={!strip()}>
        {strip() ? stripText() : ''}
      </div>
      <div id="pull" ref={pullNode} hidden aria-hidden="true" />

      <main id="screens">
        <Arrived />
        <Switch>
          <Match when={session().kind === 'checking'}>
            <div class="spinner">Loading…</div>
          </Match>
          <Match when={session().kind === 'unreachable'}>
            <h1>Spendsheet</h1>
            {/* Exclusive with "Not signed in": a signed-in owner on a bad network is not signed out. */}
            <p class="notice">Could not reach the server. Check the connection and reload.</p>
          </Match>
          <Match when={session().kind === 'out'}>
            <h1>Spendsheet</h1>
            <p>Not signed in.</p>
            <button type="button" onClick={goSignIn}>
              Sign in with Google
            </button>
          </Match>
          <Match when={signedIn()}>{(me) => <SignedIn email={me().email} />}</Match>
        </Switch>
      </main>

      <Show when={signedIn() && held()}>
        <nav id="tabs">
          <For each={TABS}>
            {(tab) => (
              <button type="button" aria-current={view().screen === tab.id ? 'page' : undefined} onClick={() => go(tab.id)}>
                <span class="glyph">{tab.glyph}</span>
                {tab.label}
              </button>
            )}
          </For>
        </nav>
      </Show>

      <Show when={signedIn() && held()}>
        <SheetHost />
      </Show>

      <div id="toast" role="status" hidden={!toastText()}>
        {toastText()}
      </div>
    </>
  );
}
