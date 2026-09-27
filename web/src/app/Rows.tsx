/**
 * Rows.tsx — a transaction, a hold, and a category's bar.
 *
 * From `page.records.html` and `page.charts.html`. Read-only for now: a row
 * is drawn exactly as it was, and what tapping or swiping it does arrives with
 * the writes. Until then it is not a button — a control that does nothing is
 * a promise the row cannot keep, the rule `pendingRow` was already following.
 */

import { For, Show } from 'solid-js';
import type { PageRecord } from '../domain/query';
import { TX_TYPE } from '../domain/schema';
import { money, withIcon } from './format';
import { categoryColor } from './geometry';
import { currency, drillToRecords, expanded, overview, toggleExpanded } from './state';

/**
 * The seed's "no real subcategory" child, `Other › Uncategorised`. As a row's
 * label it says the opposite of what happened — the row *is* categorised, as
 * Other — so it is treated as no subcategory.
 */
export const PLACEHOLDER_SUBCATEGORY = 'Uncategorised';

/** A parent's icon — the first child's, which is all `categories` stores. */
export function categoryIcon(name: string): string {
  const found = overview()?.lists.categories.parents.find((entry) => entry.name === name);
  return found ? found.icon : '';
}

/** A subcategory's own icon, so a flight is ✈️ rather than its parent's first child's 🎬. */
export function subcategoryIcon(name: string): string {
  if (!name) return '';
  const found = overview()?.lists.categories.children.find((entry) => entry.name === name);
  return found ? found.icon : '';
}

/**
 * Is this money arriving? The sign, except at zero, where a €0.00
 * pre-authorisation is a debit and `type` is the stored answer; and `null` —
 * no rate yet — is drawn as `—` and claims nothing arrived.
 */
export function moneyIn(record: Pick<PageRecord, 'amount' | 'type'>): boolean {
  if (record.amount === null) return false;
  if (record.amount === 0) return record.type === 'income';
  return record.amount > 0;
}

/** `Revolut`, or `Revolut → Fineco` when the money moved; the direction is the server's pairing, not the sign. */
export function whereLine(record: Pick<PageRecord, 'account' | 'peerAccount' | 'peerDirection'>): string {
  if (!record.peerAccount) return record.account;
  return record.peerDirection === 'from'
    ? record.peerAccount + ' → ' + record.account
    : record.account + ' → ' + record.peerAccount;
}

export function RecordRow(props: { record: PageRecord }) {
  const child = () => (props.record.subcategory === PLACEHOLDER_SUBCATEGORY ? '' : props.record.subcategory);
  const what = () => child() || props.record.category || '(uncategorised)';
  // Red for out, green for in — and neither for a transfer, or for a row you
  // asked not to count. `in_reports` excludes both from every total already.
  const moved = () => props.record.type === TX_TYPE.TRANSFER;
  const tone = () => (moved() || props.record.inReports === false ? 'moved' : moneyIn(props.record) ? 'in' : 'out');
  const amount = () => (props.record.amount === null ? '—' : money(props.record.amount, currency()));

  return (
    <div
      class="tap"
      role="group"
      aria-label={
        (props.record.confirmed ? 'Confirmed. ' : 'Needs review. ') + (moved() ? 'Transfer. ' : '') + what() + ', ' +
        props.record.date + (props.record.time ? ' ' + props.record.time : '') + ', ' + whereLine(props.record) + ', ' + amount() +
        (props.record.labels.length ? '. Labelled ' + props.record.labels.join(', ') : '') +
        (props.record.description ? '. ' + props.record.description : '')
      }
    >
      <div class="avatar" aria-hidden="true" style={{ background: categoryColor(props.record.category || what()) }}>
        {subcategoryIcon(child()) || categoryIcon(props.record.category) || ''}
        <Show when={props.record.confirmed}>
          <span class="check" />
        </Show>
      </div>
      <div class="grow">
        <div class="ellipsis">{what()}</div>
        <div class="rec-sub">{(props.record.time ? props.record.time + ' · ' : '') + whereLine(props.record)}</div>
        <Show when={props.record.description}>
          <div class="rec-desc ellipsis">{props.record.description}</div>
        </Show>
        <Show when={props.record.labels.length}>
          <div class="rec-tags">
            <For each={props.record.labels}>{(label) => <span class="tag">{label}</span>}</For>
          </div>
        </Show>
      </div>
      <span class={['num', tone()]}>{(moved() ? '⇄ ' : '') + amount()}</span>
    </div>
  );
}

export type Hold = { uid: string; date: string; time: string; account: string; description: string; amount: number | null };

/** A hold the bank has not settled: nothing to act on, and no colour, because it is not yet a fact about your money. */
export function PendingRow(props: { record: Hold }) {
  const amount = () => (props.record.amount === null ? '—' : money(props.record.amount, currency()));
  return (
    <div
      class="pending-row"
      aria-disabled="true"
      aria-label={'Pending. ' + (props.record.description || '') + ', ' + props.record.account + ', ' + amount()}
    >
      <div class="avatar" aria-hidden="true" style={{ background: 'var(--line)' }}>
        {'\u{1F551}'}
      </div>
      <div class="grow">
        <div class="ellipsis">{props.record.description || '(no description)'}</div>
        <div class="rec-sub">{props.record.account}</div>
      </div>
      <span class="num">{amount()}</span>
    </div>
  );
}

export type CategoryTotal = { name: string; total: number; children?: { name: string; total: number }[] };

/**
 * The category breakdown, as bars. **The row opens; the button at the end of
 * what it reveals goes to the transactions** — every row expands, even one
 * with no children, so one gesture never means two things depending on data
 * you cannot see. Children are drawn against their parent's total, in the
 * parent's hue, faded.
 */
export function CategoryBars(props: { rows: CategoryTotal[] | null | undefined }) {
  const biggest = () => (props.rows && props.rows[0] ? props.rows[0].total : 0) || 1;
  return (
    <Show when={props.rows && props.rows.length} fallback={<p class="muted">Nothing spent in this period.</p>}>
      <div>
        <For each={props.rows || []}>
          {(row) => {
            const open = () => !!expanded()[row.name];
            return (
              <>
                <button
                  type="button"
                  class="catrow"
                  aria-expanded={open() ? 'true' : 'false'}
                  aria-label={row.name + ' ' + money(row.total, currency()) + ', ' + (open() ? 'collapse' : 'expand')}
                  onClick={() => toggleExpanded(row.name)}
                >
                  <div class="row">
                    <span class="grow ellipsis">
                      <span class="caret" aria-hidden="true">
                        ›
                      </span>
                      {withIcon(categoryIcon(row.name), row.name)}
                    </span>
                    <span class="num">{money(row.total, currency())}</span>
                  </div>
                  <div class="bar-track">
                    <div
                      class="bar-fill"
                      style={{ background: categoryColor(row.name), width: Math.max(2, (row.total / biggest()) * 100).toFixed(1) + '%' }}
                    />
                  </div>
                </button>
                <Show when={open()}>
                  <div class="children">
                    <For each={row.children || []}>
                      {(child) => (
                        <button
                          type="button"
                          class="catkid"
                          aria-label={child.name + ' in ' + row.name + ' ' + money(child.total, currency()) + ', show these transactions'}
                          onClick={() => drillToRecords({ spendOnly: true, category: row.name, subcategory: child.name })}
                        >
                          <div class="row">
                            <span class="grow ellipsis">{child.name}</span>
                            <span class="num muted">{money(child.total, currency())}</span>
                          </div>
                          <div class="bar-track">
                            <div
                              class="bar-fill"
                              style={{
                                background: categoryColor(row.name),
                                width: Math.max(2, (child.total / (row.total || 1)) * 100).toFixed(1) + '%'
                              }}
                            />
                          </div>
                        </button>
                      )}
                    </For>
                    <button type="button" class="link catmore" onClick={() => drillToRecords({ spendOnly: true, category: row.name })}>
                      {'All ' + row.name + ' transactions →'}
                    </button>
                  </div>
                </Show>
              </>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
