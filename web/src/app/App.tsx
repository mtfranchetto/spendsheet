/**
 * App.tsx — the thin slice's whole screen.
 *
 * It exists to answer the device checks, on the phone, from the Home Screen
 * icon, and nothing else belongs in it until phase 4 ports the real screens:
 *
 *   Am I signed in — and still signed in after Add to Home Screen, and after
 *   force-quitting the icon from the app switcher? The screen says whether it
 *   is running as the installed app, so a check made in a Safari tab by mistake
 *   is visible as one.
 *
 *   Does the viewer's grant reach the book? `/api/book` reads its title, which
 *   is the proof the Picker's grant took — including a grant made on the laptop
 *   and used from the phone.
 *
 *   How long does a full read take, and how big is it? Sampled several times in
 *   one run, with Google's share split out, and a copyable summary.
 *
 * ## The three Solid rules, since none of them error
 *
 * A component body runs **once**: a signal read into a plain variable keeps its
 * first value for ever, so derived values live in the JSX or a memo. **Props
 * are getters** and must not be destructured. Nested state wants a store.
 */

import { createSignal, createResource, For, Show, onMount } from 'solid-js';
import { api, call, goSignIn, goConnect, ApiRefused, ApiNoAccess, type Book, type Health, type Me } from '../api/client';
import { googleMs, rowCounts, spread, type Sample, type ValueRanges } from '../probe';
import { admitCommand } from '../admit';

const SAMPLES = 5;

/** What the last navigation said about signing in or connecting. Read once: it describes the past. */
function landing(): { signin: string | null; connected: string | null; connect: string | null } {
  const params = new URLSearchParams(window.location.search);
  return { signin: params.get('signin'), connected: params.get('connected'), connect: params.get('connect') };
}

/** Whether this is the Home Screen icon rather than a Safari tab. */
function installed(): boolean {
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone;
  return legacy === true || window.matchMedia('(display-mode: standalone)').matches;
}

type BookState = { kind: 'ok'; book: Book } | { kind: 'no-access' } | { kind: 'signed-out' };

export default function App() {
  const [health] = createResource<Health>(() => api.health());

  // `null` is signed out, an answer rather than an error. A transport failure
  // is left to throw: "unreachable" and "signed out" must not draw one screen.
  const [me, { refetch }] = createResource<Me | null>(async () => {
    try {
      return await api.me();
    } catch (error) {
      if (error instanceof ApiRefused) return null;
      throw error;
    }
  });

  // **Reading a resource that failed throws**, and nothing here catches it: the
  // whole screen would go instead of the one message. So every read of one that
  // can fail asks `.error` first, and these are the only way anything reads them
  // — including `book`'s source, which is read like any other.
  const signedIn = () => (me.error ? undefined : me());
  const bookState = () => (book.error ? undefined : book());
  const healthState = () => (health.error ? undefined : health());

  const [book] = createResource(signedIn, async (): Promise<BookState> => {
    try {
      return { kind: 'ok', book: await api.book() };
    } catch (error) {
      if (error instanceof ApiNoAccess) return { kind: 'no-access' };
      // The session ended between the two calls — Google revoked the grant, or
      // the account left the allowlist — and the Worker has already cleared it.
      // Asking `me` again puts the whole screen in agreement, rather than
      // leaving "Signed in as" above a book that says otherwise.
      if (error instanceof ApiRefused) {
        void refetch();
        return { kind: 'signed-out' };
      }
      throw error;
    }
  });

  const [arrived, setArrived] = createSignal<ReturnType<typeof landing>>({ signin: null, connected: null, connect: null });
  onMount(() => {
    const seen = landing();
    setArrived(seen);
    // Tidy the query string so a reload does not show a stale message again.
    if (seen.signin || seen.connected || seen.connect) window.history.replaceState({}, '', window.location.pathname);
  });

  // Who was refused comes from the Worker's sealed cookie, never the URL: the
  // screen below turns it into a command the owner runs.
  const [refused] = createResource(
    () => arrived().signin === 'refused' || undefined,
    () => api.refused()
  );
  const refusedCommand = () => (refused.error ? null : admitCommand(refused()));

  const [samples, setSamples] = createSignal<Sample[]>([]);
  const [rows, setRows] = createSignal<Record<string, number>>({});
  const [probing, setProbing] = createSignal(false);
  const [probeError, setProbeError] = createSignal<string | null>(null);

  async function probe() {
    setProbing(true);
    setProbeError(null);
    setSamples([]);
    try {
      for (let i = 0; i < SAMPLES; i++) {
        const started = performance.now();
        const response = await call('/api/read');
        const body = await response.arrayBuffer();
        const total = Math.round(performance.now() - started);
        const payload = JSON.parse(new TextDecoder().decode(body)) as ValueRanges;
        setSamples([...samples(), { total, google: googleMs(response.headers.get('server-timing')), bytes: body.byteLength }]);
        setRows(rowCounts(payload));
      }
    } catch (error) {
      setProbeError(
        error instanceof ApiNoAccess ? 'The viewer cannot read the book yet — choose it first.'
          : error instanceof ApiRefused ? 'Signed out. Sign in again.'
          : 'The read failed. Try again.'
      );
    } finally {
      setProbing(false);
    }
  }

  const summary = () => {
    const list = samples();
    const google = list.map((s) => s.google).filter((ms): ms is number => ms !== null);
    return JSON.stringify(
      {
        at: new Date().toISOString(),
        installed: installed(),
        samples: list,
        totalMs: spread(list.map((s) => s.total)),
        googleMs: spread(google),
        kilobytes: list.length ? Math.round(list[list.length - 1].bytes / 1024) : null,
        rows: rows(),
        build: healthState()?.build
      },
      null,
      2
    );
  };

  return (
    <main>
      <h1>Spendsheet</h1>

      <Show when={arrived().signin === 'refused'}>
        <div class="notice">
          <p>
            <Show when={refused.error ? null : refused()} fallback="That Google account">
              {(who) => <strong>{who().email}</strong>}
            </Show>{' '}
            is not on this viewer's list.
          </p>
          <Show when={refusedCommand()}>
            {(command) => (
              <>
                <p>
                  To be let in, send this to whoever runs the viewer. They run it in <code>web/</code>, and you sign in
                  again:
                </p>
                <pre>{command()}</pre>
                <button type="button" onClick={() => navigator.clipboard?.writeText(command())}>
                  Copy command
                </button>
              </>
            )}
          </Show>
        </div>
      </Show>
      <Show when={arrived().signin === 'state' || arrived().signin === 'failed'}>
        <p class="notice">Sign-in did not complete. Try again.</p>
      </Show>
      <Show when={arrived().connect === 'unavailable'}>
        <p class="notice">Google did not answer. Try choosing the book again in a moment.</p>
      </Show>
      <Show when={arrived().connected === '1'}>
        <p class="notice">Book chosen. Checking the viewer can read it…</p>
      </Show>

      <p class="muted">{installed() ? 'Running as the Home Screen app.' : 'Running in a browser tab.'}</p>

      <Show
        when={signedIn()}
        fallback={
          <section>
            <Show when={!me.loading} fallback={<p>Checking…</p>}>
              {/* Exclusive: a signed-in owner on a bad network is not signed out. */}
              <Show
                when={me.error}
                fallback={
                  <>
                    <p>Not signed in.</p>
                    <button type="button" onClick={goSignIn}>
                      Sign in with Google
                    </button>
                  </>
                }
              >
                <p class="notice">Could not reach the server. Check the connection and reload.</p>
              </Show>
            </Show>
          </section>
        }
      >
        {(session) => (
          <>
            <section>
              <p>
                Signed in as <strong>{session().email}</strong>.
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

            <section>
              <Show when={bookState()} fallback={<p>{book.error ? 'Could not reach the book. Reload to try again.' : 'Checking the book…'}</p>}>
                {(state) => (
                  <Show when={state().kind !== 'signed-out'} fallback={<p>Checking…</p>}>
                  <Show
                    when={state().kind === 'ok' ? (state() as { book: Book }).book : null}
                    fallback={
                      <>
                        <p>The viewer cannot read your book yet.</p>
                        <button type="button" onClick={goConnect}>
                          Choose the book
                        </button>
                      </>
                    }
                  >
                    {(found) => (
                      <p>
                        Connected to <strong>{found().title}</strong> ✓ <span class="muted">({found().timeZone})</span>
                      </p>
                    )}
                  </Show>
                  </Show>
                )}
              </Show>
            </section>

            <section>
              <h2>Read timing</h2>
              <p class="muted">
                {SAMPLES} full reads of the book, one after another. Google's share is measured by the Worker; the
                total is this phone's own clock.
              </p>
              <button type="button" disabled={probing()} onClick={probe}>
                {probing() ? `Reading… ${samples().length}/${SAMPLES}` : 'Measure reads'}
              </button>
              <Show when={probeError()}>
                <p class="notice">{probeError()}</p>
              </Show>
              <Show when={samples().length}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>total ms</th>
                      <th>Google ms</th>
                      <th>KB</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={samples()}>
                      {(sample, index) => (
                        <tr>
                          <td>{index() + 1}</td>
                          <td>{sample.total}</td>
                          <td>{sample.google ?? '—'}</td>
                          <td>{Math.round(sample.bytes / 1024)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
                <p class="muted">
                  Rows:{' '}
                  {Object.entries(rows())
                    .map(([tab, count]) => `${tab} ${count}`)
                    .join(' · ')}
                </p>
                <Show when={!probing()}>
                  <pre>{summary()}</pre>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(summary())}>
                    Copy results
                  </button>
                </Show>
              </Show>
            </section>
          </>
        )}
      </Show>

      <Show when={healthState()}>
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
