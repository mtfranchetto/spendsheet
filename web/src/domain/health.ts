/**
 * health.ts — `runChecks_` from `12_monitor.gs`, the six failure detectors
 * minus the two only Apps Script can see (its own crash, and the email).
 *
 * The `.gs` insists there is exactly one opinion about whether the sync has
 * stopped, and a port is a second copy of that opinion. What keeps it the
 * *same* opinion is the parity test, which runs both over the same book with a
 * failing run, an expiring consent, a broken bank and a lost row.
 *
 * Two sources differ, by necessity:
 *
 *   - **The remembered row counts come from `_monitor`**, not script
 *     properties, which neither a browser nor the Worker can reach.
 *     `rememberRowCount_` writes both in the same call, so they agree unless a
 *     book predates `_monitor` — and then there is no count to compare, which
 *     is the `.gs`'s own answer for a book with no remembered count.
 *   - **Day differences are day numbers subtracted**, where the `.gs` divides
 *     a millisecond difference of two local midnights. Those agree except
 *     across the spring clock change, where the `.gs` used to read 23 hours as
 *     zero days — fixed there to round, which is what this computes exactly.
 */

import type { Cell } from '../sheets/records';
import type { Book } from './book';
import { configNumber } from './book';
import { cellNumber, isBlankCell } from './cells';
import { dayKey, dayOf, type Clock } from './days';
import { ALERT_KIND, RUN_RESULT } from './schema';

export type Alert = { kind: string; key: string; subject: string; detail: string };

function alert(kind: string, key: string, subject: string, detail: string): Alert {
  return { kind, key: key || '', subject, detail };
}

export function runChecks(book: Book, clock: Clock, knownRowCount: number): Alert[] {
  return [
    ...checkStaleness(book, clock),
    ...checkEmptyRuns(book),
    ...checkConsents(book, clock),
    ...checkFailingAccounts(book),
    ...checkRowLoss(book, knownRowCount)
  ];
}

/** The payload's shape: kind, subject and detail, every one a string. */
export function appHealth(book: Book, clock: Clock, rowCount: number) {
  try {
    return runChecks(book, clock, rowCount).map((found) => ({
      kind: String(found.kind || ''),
      subject: String(found.subject || ''),
      detail: String(found.detail || '')
    }));
  } catch (error) {
    return [{ kind: 'check_failed', subject: 'Could not run the health checks',
      detail: (error as Error).message }];
  }
}

function checkStaleness(book: Book, clock: Clock): Alert[] {
  const runs = book.runs;
  const threshold = configNumber(book.config, 'stale_threshold_days');

  const good = runs.filter((run) => run.result !== RUN_RESULT.FAIL);
  const lastGood = good[good.length - 1];
  if (!lastGood) {
    return runs.length
      ? [alert(ALERT_KIND.NEVER_RAN, '', 'Sync has never succeeded',
          'Every recorded run failed. See _runs and _status.')]
      : [];
  }

  const started = dayOf(lastGood.started_at, book.timeZone);
  const days = started === null ? 0 : clock.today - started;
  if (days <= threshold) return [];

  return [alert(ALERT_KIND.NEVER_RAN, '', 'Sync has not run for ' + days + ' days',
    'Last successful sync was ' + days + ' days ago (' + dayKey(started) + '). ' +
    'Check Spendsheet → Show schedule, and the Triggers page in the Apps Script editor.')];
}

function checkEmptyRuns(book: Book): Alert[] {
  const threshold = configNumber(book.config, 'empty_run_threshold_days');
  const runs = book.runs.filter((run) => (run.accounts_attempted as number) > 0);
  if (!runs.length) return [];

  const days: { [day: string]: number } = {};
  for (const run of runs) {
    const day = dayKey(dayOf(run.started_at, book.timeZone));
    if (!day) continue;
    days[day] = (days[day] || 0) + Number(run.rows_fetched || 0);
  }

  const recent = Object.keys(days).sort().reverse().slice(0, threshold);
  if (recent.length < threshold) return [];
  if (!recent.every((day) => days[day] === 0)) return [];

  return [alert(ALERT_KIND.EMPTY_RUNS, '',
    'Sync has fetched nothing for ' + threshold + ' days',
    'The last ' + threshold + ' days of syncs all ran and returned zero transactions. ' +
    'That is normal over a quiet weekend and not over ' + threshold + ' days — check ' +
    '_status for a consent that has expired.')];
}

function checkConsents(book: Book, clock: Clock): Alert[] {
  const warn = configNumber(book.config, 'consent_warning_days');
  const out: Alert[] = [];

  for (const row of book.status) {
    if (!row.connection_id || !row.valid_until) continue;
    const until = dayOf(row.valid_until, book.timeZone);
    const days = until === null ? 0 : until - clock.today;
    if (days > warn) continue;

    const expired = days < 0;
    const provider = String(row.provider);
    out.push(alert(ALERT_KIND.CONSENT, String(row.connection_id),
      expired
        ? provider + ': bank consent has expired'
        : provider + ': bank consent expires in ' + days + ' days',
      (expired
        ? 'The consent for ' + provider + ' expired on ' + dayKey(until) + '.'
        : 'The consent for ' + provider + ' expires on ' + dayKey(until) + '.') +
      ' Reconnect with Spendsheet → Connect a bank. Nothing is lost by waiting — history ' +
      'already fetched stays — but no new transactions arrive until you do.'));
  }
  return out;
}

function checkFailingAccounts(book: Book): Alert[] {
  return book.status
    .filter((row) => row.connection_id && row.last_error)
    .map((row) => {
      const error = String(row.last_error);
      const provider = String(row.provider);

      if (error.indexOf('consent expired') !== -1) {
        return alert(ALERT_KIND.CONSENT, String(row.connection_id),
          provider + ': reconnect needed',
          error + '\n\nNothing else is affected — the other banks keep syncing, ' +
          'and this one resumes from where it stopped once you reconnect.');
      }

      return alert(ALERT_KIND.ACCOUNT_FAILING, String(row.connection_id),
        provider + ': last sync failed',
        provider + ' reported: ' + error);
    });
}

/**
 * Failure 6, from `_monitor`. A drop is excused only by rows archived to
 * `_removed` since the count was remembered, whose uid is gone from the ledger.
 */
function checkRowLoss(book: Book, current: number): Alert[] {
  const recorded = Number(cellNumber(book.monitor?.transactions_rows) || 0);
  if (!recorded || current >= recorded) return [];

  const archived = archivedSinceRemembered(book, book.monitor?.removed_rows);
  if (current + archived >= recorded) return [];

  return [alert(ALERT_KIND.ROWS_LOST, '',
    'Rows have disappeared from transactions',
    'transactions held ' + recorded + ' rows and now holds ' + current + '. That tab is ' +
    'append-only, so this is never legitimate — a sort, a deleted range, or an undo that ' +
    'took more than it appeared to.' +
    (archived ? ' ' + archived + ' of the missing rows have a copy in _removed' +
      ', which does not account for the rest.' : '') +
    ' Syncing is blocked until it is resolved: File → Version ' +
    'history to restore, then Spendsheet → Accept row count.')];
}

/** Absent means excuse nothing, not zero — see `archivedSinceRemembered_`. */
function archivedSinceRemembered(book: Book, rememberedCount: Cell | undefined): number {
  if (isBlankCell(rememberedCount)) return 0;
  const remembered = Number(rememberedCount);
  if (!Number.isFinite(remembered)) return 0;

  const archive = book.removedUids;
  if (archive.length <= remembered) return 0;

  const present = new Set(book.transactions.map((row) => String(row.uid)));
  const gone = new Set<string>();
  for (const uid of archive.slice(remembered)) {
    if (isBlankCell(uid) || present.has(String(uid))) continue;
    gone.add(String(uid));
  }
  return gone.size;
}
