/**
 * App.tsx — phase 1's whole screen.
 *
 * It exists to answer three questions on the actual phone, and nothing else
 * belongs in it until phase 3 starts porting real screens:
 *
 *   Am I signed in — and, the one that matters, am I *still* signed in after
 *   iOS has killed the web clip and I have reopened it from the icon? That is
 *   the gesture the whole architecture was chosen for, and it is the one that
 *   could refute it.
 *
 *   Is this deployment configured, and which build is it? `/api/health` says
 *   which bindings exist without saying anything about the book, so a broken
 *   deployment can be told apart from a broken configuration without being
 *   signed in.
 *
 *   Does the credential actually reach the Sheet?
 *
 * ## The three Solid rules, since none of them error
 *
 * A component body runs **once**. A signal read assigned to a plain variable
 * captures that first value for ever, so anything derived goes in a `createMemo`
 * or is read inside the JSX — where the compiler wraps it in a tracking scope.
 *
 * **Props are getters and must not be destructured.** Destructuring reads them
 * once, at that same run-once moment, and silently breaks the reactive chain.
 *
 * Nested state wants `createStore`, not a signal holding an object: a store
 * updates the leaf instead of replacing the branch, which is what
 * `agreeWithLocalWrites` will need in phase 4.
 */

import { createSignal, createResource, Show, onMount } from 'solid-js';
import { api, goSignIn, ApiRefused, type Health, type Me } from '../api/client';

/**
 * Why the sign-in failed, if it did.
 *
 * `/api/callback` puts an outcome in the query string because a redirect has
 * nowhere else to carry one — the response body of a 302 is never rendered.
 * Read once on mount: it describes a navigation that has already happened, so
 * it is not reactive and does not want to be.
 */
function signInOutcome(): string | null {
  return new URLSearchParams(window.location.search).get('signin');
}

export default function App() {
  const [health] = createResource<Health>(() => api.health());

  // `null` means signed out, which is an answer rather than an error — hence
  // catching only the refusal. A transport failure is left to throw, because
  // "the server is unreachable" and "you are signed out" must not draw the
  // same screen.
  const [me, { refetch }] = createResource<Me | null>(async () => {
    try {
      return await api.me();
    } catch (error) {
      if (error instanceof ApiRefused) return null;
      throw error;
    }
  });

  const [outcome, setOutcome] = createSignal<string | null>(null);

  onMount(() => {
    setOutcome(signInOutcome());

    // Tidy the query string so a reload does not re-show a stale complaint.
    // `replaceState` rather than a navigation: there is nothing to fetch.
    if (signInOutcome()) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  });

  return (
    <main>
      <h1>Spendsheet</h1>

      <Show when={outcome() === 'wrong-account'}>
        <p class="notice">
          That Google account is not the one this app belongs to. Sign in again and
          choose the other one.
        </p>
      </Show>

      <Show when={outcome() === 'state' || outcome() === 'failed'}>
        <p class="notice">Sign-in did not complete. Try again.</p>
      </Show>

      <Show
        when={me()}
        fallback={
          <section>
            <p>Not signed in.</p>
            <button type="button" onClick={goSignIn}>
              Sign in with Google
            </button>
          </section>
        }
      >
        {/*
          A callback child, so `me()` is read inside the tracking scope rather
          than captured at the run-once moment. `me()!` outside here would be
          the first Solid mistake everybody makes.
        */}
        {(session) => (
          <section>
            <p>
              Signed in as <strong>{session().email}</strong>.
            </p>
            <p class="muted">
              Session valid until {new Date(session().exp * 1000).toLocaleString()}.
            </p>
            <button
              type="button"
              onClick={async () => {
                await api.signOut();
                refetch();
              }}
            >
              Sign out
            </button>
          </section>
        )}
      </Show>

      <Show when={health()}>
        {(state) => (
          <footer class="muted">
            <p>build {state().build}</p>
            <p>
              configured:{' '}
              {Object.entries(state().configured)
                .map(([name, ok]) => `${name} ${ok ? 'yes' : 'NO'}`)
                .join(' · ')}
            </p>
          </footer>
        )}
      </Show>
    </main>
  );
}
