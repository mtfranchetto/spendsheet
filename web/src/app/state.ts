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
 *
 * ## Writes patch the book; a read older than a write is not believed
 *
 * A write answers with the rows it touched, read back from Google, and those
 * rows are patched into the book the page holds — so the screen is the book
 * as Google now has it without reading all of it again. While a write is out,
 * its guess at the answer sits in `overlay`, on top of the book, keyed by uid.
 *
 * The trap is the one the Apps Script page hit as a row you swipe twice: a
 * read that left **before** a write landed comes back holding the book as it
 * was, and replacing the book with it undoes the write on screen. So every
 * read is stamped with the number of writes issued when it left, and a read
 * that left while a write was out, comes back to a different number, or comes
 * back while any write is out, is dropped — and read again once the writes
 * have settled. Being a read late
 * costs nothing; being a write wrong costs the row.
 */

import { createMemo, createRoot, createSignal } from 'solid-js';
import { api, ApiNoAccess, ApiRefused, ApiStale, type Me } from '../api/client';
import type { FreshRows } from '../api/contract';
import { bookFromBatch, tabOf, type BatchGet, type Book, type Row } from '../domain/book';
import { clockAt } from '../domain/days';
import { longView as longViewOf } from '../domain/longview';
import { appAnalyticsData, appOpenData, appOverviewData, appRecordsData } from '../domain/payloads';
import { ledgerOf, type Period } from '../domain/query';
import { QUERY_PAGE_SIZE, TABS } from '../domain/schema';
import type { Cell } from '../sheets/records';
import { forgetCopy, readAnyCopy, writeCopy, type StoredCopy } from '../store/copy';
import { parseView, type AnalyticsFilters, type ChartsMode, type RecordsFilters, type Screen, type View } from './view';

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

/** A write's guess at a row, until its answer lands: the columns it will change, or `null` for a row it removes. */
type Layer = { id: number; fields: { [column: string]: Cell } | null };
const [overlay, setOverlay] = createSignal<{ [uid: string]: Layer[] }>({});

/** The dialog over the screen: a row's details, or a rule made from one. */
export type SheetState = { kind: 'detail' | 'rule'; uid: string } | null;
const [sheet, setSheet] = createSignal<SheetState>(null);
/** The account "+ Add" or "Update" was pressed on, for the form it opens. */
const [formAccount, setFormAccount] = createSignal('');

export { session, held, reading, pulled, noAccess, readFailed, toastText, view, recordsShown, expanded, sheet, formAccount };

/** The book with every write still out laid over it. */
function withOverlay(book: Book, layers: { [uid: string]: Layer[] }): Book {
  const uids = Object.keys(layers);
  if (!uids.length) return book;
  const transactions: Row[] = [];
  for (const row of book.transactions) {
    const stack = layers[String(row.uid)];
    if (!stack) {
      transactions.push(row);
      continue;
    }
    if (stack.some((layer) => layer.fields === null)) continue;
    transactions.push(Object.assign({ ...row }, ...stack.map((layer) => layer.fields)));
  }
  return { ...book, transactions };
}

/*
  Derived in a root of their own: memos need an owner, and these outlive every
  component. Records and Charts are lazy, so the screen you are not looking at
  costs nothing until you open it.
*/
const derived = createRoot(() => {
  const read = createMemo(() => {
    const h = held();
    return h ? bookFromBatch(h.batch, h.timeZone) : null;
  });
  const book = createMemo(() => {
    const b = read();
    return b ? withOverlay(b, overlay()) : null;
  });
  // Where each uid sits in the sheet, as last read — what a write names a row by.
  const rowsByUid = createMemo(() => {
    const map = new Map<string, Row>();
    for (const row of read()?.transactions ?? []) if (row.uid !== '') map.set(String(row.uid), row);
    return map;
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
  // rows of the same sort the old viewer paged through, so each page the parity
  // test holds is a slice of this list.
  const records = createMemo(
    () => {
      const b = book();
      const c = clock();
      return b && c ? appRecordsData(b, ledger(), recordsFilters(), 0, c, recordsShown()) : null;
    },
    { lazy: true }
  );

  // Charts' other mode. It reads no filter, so only the book and the day move it.
  const longView = createMemo(
    () => {
      const b = book();
      const c = clock();
      return b && c ? longViewOf(b, ledger(), c) : null;
    },
    { lazy: true }
  );

  return { book, rowsByUid, clock, open, overview, analytics, records, longView };
});

export const { book, clock, open, overview, analytics, records, longView } = derived;

/** The row a uid names, as the book last read it — its sheet row is `_row`. */
export const rowOf = (uid: string): Row | undefined => derived.rowsByUid().get(uid);

/** The book's currency, for every figure on screen. */
export const currency = () => open()?.currency || 'EUR';

// ---------------------------------------------------------------------------
// Signing in, reading, and forgetting
// ---------------------------------------------------------------------------

let generation = 0;
/** Writes issued so far, and writes not yet answered. A read is believed only if neither moved while it was out. */
let writesIssued = 0;
let writesOut = 0;
let rereadAfterWrites = false;
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
  const stamp = writesIssued;
  // A write already out may not have reached Google before this read does.
  const writing = writesOut > 0;
  setReading(true);
  try {
    const [batch, book] = await Promise.all([api.read(), api.book()]);
    if (gen !== generation || mine !== reads) return;
    if (writing || stamp !== writesIssued || writesOut > 0) {
      // Older than a write: it would put the row back as it was. Read again when the writes settle.
      rereadAfterWrites = true;
      if (writesOut === 0) {
        rereadAfterWrites = false;
        void refresh();
      }
      return;
    }
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
  setOverlay({});
  setSheet(null);
  const forgot = forgetCopy();
  setHeld(null);
  setReading(false);
  setPulled(false);
  setSession({ kind: 'out' });
  return forgot.then(() => undefined);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

let layerIds = 0;

/**
 * A write is going out. Returns its generation, which `wrote` and `unlayer`
 * check: a write that lands after a sign-out must not put anything back.
 */
export function writeStarted(): number {
  writesIssued++;
  writesOut++;
  return generation;
}

export function writeSettled(): void {
  writesOut = Math.max(0, writesOut - 1);
  if (writesOut === 0 && rereadAfterWrites) {
    rereadAfterWrites = false;
    void refresh();
  }
}

/** Lay a guess over a row until its write lands. Returns the layer's id. */
export function layer(uid: string, fields: { [column: string]: Cell } | null): number {
  const id = ++layerIds;
  setOverlay((current) => ({ ...current, [uid]: [...(current[uid] ?? []), { id, fields }] }));
  return id;
}

export function unlayer(ids: number[]): void {
  if (!ids.length) return;
  setOverlay((current) => {
    const next: { [uid: string]: Layer[] } = {};
    for (const [uid, stack] of Object.entries(current)) {
      const kept = stack.filter((entry) => ids.indexOf(entry.id) === -1);
      if (kept.length) next[uid] = kept;
    }
    return next;
  });
}

/**
 * Google's answer to a write, into the book the page holds and the copy on
 * disk: the rows it read back, and the sheet row it deleted, whose gap closes
 * just as the sheet's did.
 */
export function wrote(gen: number, rows: FreshRows, removed?: number): void {
  const h = held();
  if (!h || gen !== generation) return;
  if (!Object.keys(rows).length && !removed) return;
  const valueRanges = (h.batch.valueRanges ?? []).map((range) => {
    if (tabOf(range.range) !== TABS.TRANSACTIONS) return range;
    const values = (range.values ?? []).slice();
    for (const [row, cells] of Object.entries(rows)) {
      const at = Number(row) - 1;
      while (values.length < at) values.push([]);
      values[at] = cells;
    }
    if (removed) values.splice(removed - 1, 1);
    return { ...range, values };
  });
  // A deleted row is archived to `_removed`, and the row-loss check excuses the
  // drop by exactly that uid: the copy has to say so too, or the delete reads
  // as rows gone missing until the next full read.
  const gone = removed ? transactionsOf(h.batch)?.[removed - 1]?.[0] : undefined;
  const archived = gone === undefined || gone === '' ? valueRanges : valueRanges.map((range) =>
    tabOf(range.range) === TABS.REMOVED ? { ...range, values: [...(range.values ?? [['uid']]), [gone]] } : range
  );
  const batch = { ...h.batch, valueRanges: archived };
  setHeld({ ...h, batch });
  if (owner) void writeCopy({ owner: owner.sub, email: owner.email, timeZone: h.timeZone, batch, savedAt: h.savedAt });
}

/**
 * What a failed write means. A refusal of the session ends it, as a read's
 * would; a page older than the Worker reloads; anything else is said, and the
 * book is read again — a write refused for a row that moved is a page whose
 * idea of the book is out of date.
 */
function transactionsOf(batch: BatchGet): Cell[][] | undefined {
  return batch.valueRanges?.find((range) => tabOf(range.range) === TABS.TRANSACTIONS)?.values;
}

export function writeFailed(error: unknown): void {
  if (error instanceof ApiRefused) {
    void forgetEverything();
    return;
  }
  if (error instanceof ApiStale) {
    toast(error.message);
    window.location.reload();
    return;
  }
  toast(error instanceof Error ? error.message : String(error));
}

export function openSheet(kind: 'detail' | 'rule', uid: string): void {
  setSheet({ kind, uid });
}

export function closeSheet(): void {
  setSheet(null);
}

/** "+ Add" and "Update": the form, open on the account the button was on. */
export function openForm(screen: 'add' | 'value', account: string): void {
  setFormAccount(account);
  go(screen);
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

/** Period or Long view. The period's filters are kept, so switching back finds them as they were. */
export function setChartsMode(mode: ChartsMode): void {
  setView((current) => ({ ...current, charts: mode }));
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
 *
 * A figure from the long view brings its own `period` and nothing else: it was
 * summed over every account and label, so the period's filters do not apply.
 */
export function drillToRecords(drill: {
  spendOnly?: boolean; incomeOnly?: boolean; category?: string; subcategory?: string; period?: Period;
}): void {
  const from = view().analytics;
  const chosen = from.period.kind === 'custom' ? { kind: 'custom', from: from.period.from, to: from.period.to } : from.period;
  replaceRecordsFilters({
    period: drill.period ? { ...drill.period } : chosen,
    account: drill.period ? 'All' : from.account,
    label: drill.period ? 'All' : from.label,
    search: '',
    unconfirmedOnly: false,
    spendOnly: !!drill.spendOnly,
    incomeOnly: !!drill.incomeOnly,
    category: drill.category || 'All',
    subcategory: drill.subcategory || 'All'
  });
  go('records');
}
