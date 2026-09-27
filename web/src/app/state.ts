/**
 * state.ts — who is signed in, which book is on screen, and everything drawn from it.
 *
 * ## The whole book is on the phone, so a filter costs nothing
 *
 * The Apps Script viewer asked the server a question per screen and per
 * filter, and most of its page was about that: request stamps so a late
 * answer could not overwrite a newer one, slice caches keyed by a signature
 * of the filters, a `hydrated` mark per slice. None of it survives here,
 * because none of it is needed — the page holds the book, and every screen is
 * a memo over it. Changing a filter recomputes; it does not fetch.
 *
 * What remains of the old boot is the part that was always right: **draw the
 * last copy, then ask anyway**. The stored copy is drawn before the read goes
 * out and replaced when it lands; the read is unconditional, because a screen
 * that trusted its copy would never be right again.
 *
 * ## A refusal stops the answers already in flight
 *
 * `generation` is the latch. Signing out and being refused both advance it
 * and forget the stored copy, and every read checks it before applying or
 * storing anything — so a read that was in the air when you signed out cannot
 * put the previous account's book back on screen or back on disk. The Apps
 * Script page learned this twice (`state.refused`, and the forget that an
 * ordering bug skipped); here it is one integer, checked in one place.
 *
 * A dropped connection is not a refusal. `ApiRefused` forgets; anything else
 * keeps what is on screen and says the copy is old.
 */

import { createMemo, createRoot, createSignal } from 'solid-js';
import { api, ApiNoAccess, ApiRefused, type Me } from '../api/client';
import { bookFromBatch, type BatchGet } from '../domain/book';
import { clockAt } from '../domain/days';
import { appAnalyticsData, appOpenData, appOverviewData, appRecordsData } from '../domain/payloads';
import { ledgerOf } from '../domain/query';
import { QUERY_PAGE_SIZE } from '../domain/schema';
import { forgetCopy, readAnyCopy, writeCopy, type StoredCopy } from '../store/copy';
import { parseView, type AnalyticsFilters, type RecordsFilters, type Screen, type View } from './view';

export type Session = { kind: 'checking' } | { kind: 'out' } | { kind: 'unreachable' } | { kind: 'in'; me: Me };

/** A book on screen: the batch it came from, and whether it is the stored copy or a fresh read. */
export type Held = { batch: BatchGet; timeZone: string; savedAt: number; fromCache: boolean };

const [session, setSession] = createSignal<Session>({ kind: 'checking' });
const [held, setHeld] = createSignal<Held | null>(null);
const [reading, setReading] = createSignal(false);
const [pulled, setPulled] = createSignal(false);
const [noAccess, setNoAccess] = createSignal(false);
const [readFailed, setReadFailed] = createSignal(false);
const [toastText, setToastText] = createSignal('');
const [view, setView] = createSignal<View>(parseView(window.location.search, new Date().getFullYear()));
const [recordsShown, setRecordsShown] = createSignal(QUERY_PAGE_SIZE);
const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});

export { session, held, reading, pulled, noAccess, readFailed, toastText, view, recordsShown, expanded };

/*
  Derived in a root of their own: memos need an owner, and these outlive every
  component. Records and Charts are lazy, so the screen you are not looking at
  costs nothing until you open it.
*/
const derived = createRoot(() => {
  const book = createMemo(() => {
    const h = held();
    return h ? bookFromBatch(h.batch, h.timeZone) : null;
  });
  // "Today" is the book's, taken when the book arrived — a Clock in its zone,
  // never the phone's, so the day boundaries match the `.gs`.
  const clock = createMemo(() => {
    const h = held();
    return h ? clockAt(new Date(), h.timeZone) : null;
  });
  const ledger = createMemo(() => {
    const b = book();
    return b ? ledgerOf(b) : [];
  });
  const open = createMemo(() => {
    const b = book();
    const c = clock();
    return b && c ? appOpenData(b, c) : null;
  });
  const overview = createMemo(() => {
    const b = book();
    const c = clock();
    return b && c ? appOverviewData(b, ledger(), c) : null;
  });

  // Separate memos for each screen's filters, so changing one screen's does
  // not recompute the other: `updateView` keeps the untouched half's identity.
  const analyticsFilters = createMemo(() => view().analytics);
  const recordsFilters = createMemo(() => view().records);

  const analytics = createMemo(
    () => {
      const b = book();
      const c = clock();
      return b && c ? appAnalyticsData(b, ledger(), analyticsFilters(), c) : null;
    },
    { lazy: true }
  );

  // Everything "Load more" has shown, in one pass: the first `recordsShown`
  // rows of the same sort the `.gs` paged through, so each page the parity
  // test holds is a slice of this list.
  const records = createMemo(
    () => {
      const b = book();
      const c = clock();
      return b && c ? appRecordsData(b, ledger(), recordsFilters(), 0, c, recordsShown()) : null;
    },
    { lazy: true }
  );

  return { book, clock, open, overview, analytics, records };
});

export const { clock, open, overview, analytics, records } = derived;

/** The book's currency, for every figure on screen. */
export const currency = () => open()?.currency || 'EUR';

// ---------------------------------------------------------------------------
// Signing in, reading, and forgetting
// ---------------------------------------------------------------------------

let generation = 0;
/** Who the last `/api/me` said is signed in; null until one has answered. */
let owner: Me | null = null;
let reads = 0;

/**
 * The open: who is this, draw what this device kept for them, then read.
 *
 * The stored copy is read **alongside** `/api/me`, not after it, and drawn
 * only once the account it belongs to is the one answering — so an online
 * open costs one round trip before the copy appears, and never shows one
 * account's balances to another. With no connection at all there is nobody
 * to ask, and the copy is drawn anyway: see `readAnyCopy` for why a copy still
 * on the device belongs to the session still on it.
 */
export async function start(): Promise<void> {
  const gen = generation;
  const stored = readAnyCopy();
  let me: Me;
  try {
    me = await api.me();
  } catch (error) {
    if (gen !== generation) return;
    if (error instanceof ApiRefused) return forgetEverything();
    // Unreachable is not signed out: the copy stays, and is drawn if there is one.
    const copy = await stored;
    if (gen !== generation) return;
    if (!copy) {
      setSession({ kind: 'unreachable' });
      return;
    }
    show(copy);
    setSession({ kind: 'in', me: { sub: copy.owner, email: copy.email ?? '' } });
    setReadFailed(true);
    return;
  }
  if (gen !== generation) return;
  owner = me;
  setSession({ kind: 'in', me });

  const copy = await stored;
  // Only if no read has landed meanwhile — a stored copy never replaces a fresh one.
  if (copy && copy.owner === me.sub && gen === generation && reads === 0) show(copy);
  await refresh();
}

function show(copy: StoredCopy): void {
  setHeld({ batch: copy.batch, timeZone: copy.timeZone, savedAt: copy.savedAt, fromCache: true });
}

/** Read the book again. The last read issued is the one that is drawn. */
export async function refresh(): Promise<void> {
  const reader = owner;
  if (!reader) return;
  const gen = generation;
  const mine = ++reads;
  setReading(true);
  try {
    const [batch, book] = await Promise.all([api.read(), api.book()]);
    if (gen !== generation || mine !== reads) return;
    const copy = { owner: reader.sub, email: reader.email, timeZone: book.timeZone, batch, savedAt: Date.now() };
    setNoAccess(false);
    setReadFailed(false);
    setHeld({ batch, timeZone: book.timeZone, savedAt: copy.savedAt, fromCache: false });
    // Stored as the server sent it. A failed write costs only the next open.
    void writeCopy(copy);
  } catch (error) {
    if (gen !== generation) return;
    if (error instanceof ApiRefused) return forgetEverything();
    if (error instanceof ApiNoAccess) {
      setNoAccess(true);
    } else {
      setReadFailed(true);
      if (held()) toast('Could not reach the book. This is the last copy this phone kept.');
    }
  } finally {
    if (mine === reads) {
      setReading(false);
      setPulled(false);
    }
  }
}

/** A pull: the same read, with the strip up while it runs — or, if nobody has answered yet, the whole open again. */
export function pullToRefresh(): void {
  if (reading()) return;
  if (!owner) {
    void start();
    return;
  }
  setPulled(true);
  void refresh();
}

/**
 * Nothing of this account may stay on this device. Advancing the generation
 * first is what stops a read already in flight from undoing the forget.
 */
function forgetEverything(): Promise<void> {
  generation++;
  owner = null;
  const forgot = forgetCopy();
  setHeld(null);
  setReading(false);
  setPulled(false);
  setSession({ kind: 'out' });
  return forgot.then(() => undefined);
}

export async function signOut(): Promise<void> {
  const forgot = forgetEverything();
  try {
    await api.signOut();
  } catch {
    // The copy is gone either way; the cookie goes on the next sign-out that reaches us.
  }
  await forgot;
}

// ---------------------------------------------------------------------------
// What is on screen
// ---------------------------------------------------------------------------

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string): void {
  setToastText(message);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setToastText(''), 4000);
}

export function go(screen: Screen): void {
  setView((current) => ({ ...current, screen }));
  window.scrollTo(0, 0);
}

export function setAnalyticsFilters(change: Partial<AnalyticsFilters>): void {
  setView((current) => ({ ...current, analytics: { ...current.analytics, ...change } }));
}

/** Records' filters, and the list back to its first page: it is a different question now. */
export function setRecordsFilters(change: Partial<RecordsFilters>): void {
  setView((current) => ({ ...current, records: { ...current.records, ...change } }));
  setRecordsShown(QUERY_PAGE_SIZE);
}

export function replaceRecordsFilters(filters: RecordsFilters): void {
  setView((current) => ({ ...current, records: filters }));
  setRecordsShown(QUERY_PAGE_SIZE);
}

export function showMoreRecords(): void {
  setRecordsShown((shown) => shown + QUERY_PAGE_SIZE);
}

/** Keyed by name, so an open category stays open when a filter re-ranks the list. */
export function toggleExpanded(name: string): void {
  setExpanded((current) => ({ ...current, [name]: !current[name] }));
}

/**
 * A number on Charts, opened as the rows behind it. Records' filters are
 * **replaced**, not merged: a search typed last week surviving would make a
 * list that no longer sums to the figure you tapped. A custom period is
 * cloned so editing it on Records cannot reach back into Charts.
 */
export function drillToRecords(drill: { spendOnly?: boolean; incomeOnly?: boolean; category?: string; subcategory?: string }): void {
  const from = view().analytics;
  replaceRecordsFilters({
    period: from.period.kind === 'custom' ? { kind: 'custom', from: from.period.from, to: from.period.to } : from.period,
    account: from.account,
    label: from.label,
    search: '',
    unconfirmedOnly: false,
    spendOnly: !!drill.spendOnly,
    incomeOnly: !!drill.incomeOnly,
    category: drill.category || 'All',
    subcategory: drill.subcategory || 'All'
  });
  go('records');
}
