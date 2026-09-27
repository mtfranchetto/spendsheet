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
import { forgetCopy, readCopy, writeCopy } from '../store/copy';
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

  // Pages concatenated up to what "Load more" has asked for. Each page is the
  // same function the `.gs` served, at its offset, so the parity test's
  // answer for a page is this screen's answer for it.
  const records = createMemo(
    () => {
      const b = book();
      const c = clock();
      if (!b || !c) return null;
      const first = appRecordsData(b, ledger(), recordsFilters(), 0, c);
      const rows = first.rows.slice();
      let page = first;
      while (page.hasMore && rows.length < recordsShown()) {
        page = appRecordsData(b, ledger(), recordsFilters(), rows.length, c);
        rows.push(...page.rows);
      }
      return { ...first, rows, hasMore: rows.length < first.total };
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
let owner: string | null = null;
let reads = 0;

/** The open: who is this, draw what this device kept for them, then read. */
export async function start(): Promise<void> {
  const gen = generation;
  let me: Me;
  try {
    me = await api.me();
  } catch (error) {
    if (gen !== generation) return;
    if (error instanceof ApiRefused) return forgetEverything();
    // Unreachable is not signed out: the copy stays for the open that can reach us.
    setSession({ kind: 'unreachable' });
    return;
  }
  if (gen !== generation) return;
  owner = me.sub;
  setSession({ kind: 'in', me });

  const copy = await readCopy(me.sub);
  // Only if no read has landed meanwhile — a stored copy never replaces a fresh one.
  if (copy && gen === generation && reads === 0) {
    setHeld({ batch: copy.batch, timeZone: copy.timeZone, savedAt: copy.savedAt, fromCache: true });
  }
  await refresh();
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
    const copy = { owner: reader, timeZone: book.timeZone, batch, savedAt: Date.now() };
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

/** A pull: the same read, with the strip up while it runs. */
export function pullToRefresh(): void {
  if (reading()) return;
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
