/**
 * Dashboard.tsx — Home: net worth, the accounts, the month, and what needs you.
 *
 * Summary then detail; holds last, because they are a footnote; and a month
 * compared with the same point of last month rather than with all of it,
 * because a month half over always looks cheaper than a whole one. The long
 * form of each is in `git log -- src/page.dashboard.html`.
 *
 * Both halves come from the same book, which is either on the phone or not,
 * so there is no moment where the top is drawn and the ledger half is not.
 */

import { For, Show } from 'solid-js';
import { money, shortDate } from './format';
import { LineChart } from './Charts';
import { CategoryBars, PendingRow, RecordRow } from './Rows';
import { currency, go, open, openForm, overview, setRecordsFilters } from './state';

type Account = NonNullable<ReturnType<typeof open>>['accounts'][number];

/**
 * An account's mark: a problem when there is one, otherwise what kind of
 * account it is. A green dot on every healthy tile would be an alert glyph
 * saying nothing, and would train the eye to skip the one that isn't green.
 */
function accountEmoji(account: Account, cash: string[], assets: string[]): string {
  if (account.severity === 2) return '\u{1F534}';
  if (account.severity === 1) return '\u{1F7E0}';
  if (cash.indexOf(account.name) !== -1) return '\u{1F4B5}';
  if (assets.indexOf(account.name) !== -1) return '\u{1F4C8}';
  return '\u{1F3E6}';
}

/**
 * One account, pressed to show what is in it. The whole tile is the target,
 * not only the button inside it — the tile's padding and a grid row stretched
 * to its tallest neighbour would otherwise be dead strips around a control
 * whose whole job is to be hit with a thumb.
 */
function AccountTile(props: { account: Account }) {
  const lists = () => open()?.lists;
  const show = () => {
    setRecordsFilters({ account: props.account.name, unconfirmedOnly: false });
    go('records');
  };
  const cash = () => (lists()?.cashAccounts || []).indexOf(props.account.name) !== -1;
  const asset = () => (lists()?.assetAccounts || []).some((entry) => entry.name === props.account.name);
  return (
    <div
      class={['tile', props.account.severity ? 'sev' + props.account.severity : '']}
      onClick={(event) => {
        // The tile's own buttons do their own thing.
        if ((event.target as HTMLElement).closest('button.link')) return;
        show();
      }}
    >
      <button
        type="button"
        class="face"
        aria-label={'Show records for ' + props.account.name + (props.account.severity ? '. ' + props.account.sync : '')}
      >
        <div class="who">
          <span>{accountEmoji(props.account, lists()?.cashAccounts || [], (lists()?.assetAccounts || []).map((a) => a.name))}</span>
          <div class="ellipsis grow">{props.account.name}</div>
        </div>
        <div class="amount num">
          {props.account.balance === null
            ? '—'
            : money(props.account.balance, currency()) + (props.account.currency === currency() ? '' : ' ' + props.account.currency)}
        </div>
        <Show when={props.account.severity}>
          <div class="muted note">{props.account.sync}</div>
        </Show>
      </button>
      <Show when={cash()}>
        <button type="button" class="link" aria-label={'Add a transaction to ' + props.account.name} onClick={() => openForm('add', props.account.name)}>
          + Add
        </button>
      </Show>
      <Show when={asset()}>
        <button type="button" class="link" aria-label={'Update the balance of ' + props.account.name} onClick={() => openForm('value', props.account.name)}>
          ↕ Update
        </button>
      </Show>
    </div>
  );
}

export function Dashboard() {
  return (
    <Show when={open()} fallback={<div class="spinner">Loading…</div>}>
      {(top) => (
        <>
          <h1>Spendsheet</h1>

          <For each={overview()?.health || []}>
            {(alert) => (
              <div class={['banner', alert.kind === 'consent' ? 'warn' : 'bad']}>
                <div>{alert.subject}</div>
                <div class="muted">{alert.detail}</div>
              </div>
            )}
          </For>

          <div class="card">
            <div class="muted">Net worth</div>
            <div class="big num">{money(top().netWorth.total, currency())}</div>
            <Show when={top().netWorth.skipped}>
              <div class="muted">
                {top().netWorth.skipped + ' account(s) not counted — either out of net worth, or not in ' + top().currency}
              </div>
            </Show>
          </div>

          <h2>Accounts</h2>
          <Show
            when={top().accounts.length}
            fallback={
              <div class="card">
                <p class="muted">No accounts yet — connect a bank from the Sheet.</p>
              </div>
            }
          >
            <div class="tiles">
              <For each={top().accounts}>{(account) => <AccountTile account={account} />}</For>
            </div>
          </Show>

          <Show when={overview()}>
            {(data) => (
              <>
                <Show when={data().trend.series.length}>
                  <h2>{'Net worth, last ' + data().trend.days + ' days'}</h2>
                  <div class="card">
                    <LineChart series={data().trend.series} />
                  </div>
                </Show>

                <h2>This month</h2>
                <div class="card">
                  <div class="row">
                    <span>{'Spent since ' + shortDate(data().month.from)}</span>
                    <span class="num out">{money(data().month.expenses, currency())}</span>
                  </div>
                  <div class="row">
                    <span>Earned</span>
                    <span class="num in">{money(data().month.income, currency())}</span>
                  </div>
                  <div class="row">
                    <span>Net</span>
                    <span class={['num', data().month.net < 0 ? 'out' : 'in']}>{money(data().month.net, currency())}</span>
                  </div>
                  <div class="row">
                    <span class="muted">Same point last month</span>
                    <span class="num muted">
                      {(() => {
                        const difference = data().month.expenses - data().month.lastMonthToDate;
                        return money(data().month.lastMonthToDate, currency()) + '  (' + (difference >= 0 ? '+' : '') + money(difference, currency()) + ')';
                      })()}
                    </span>
                  </div>
                </div>

                <h2>This month, by category</h2>
                <div class="card">
                  <CategoryBars rows={data().month.byCategory} />
                </div>

                <h2>Needs review</h2>
                <div class="card">
                  <Show when={data().review.length} fallback={<p class="muted">Nothing waiting — every transaction is confirmed.</p>}>
                    <For each={data().review.slice(0, 10)}>{(record) => <RecordRow record={record} />}</For>
                  </Show>
                  <Show when={data().review.length > 10}>
                    <button
                      type="button"
                      class="link"
                      onClick={() => {
                        setRecordsFilters({ unconfirmedOnly: true });
                        go('records');
                      }}
                    >
                      {'See all ' + data().review.length + ' in Records'}
                    </button>
                  </Show>
                </div>

                <Show when={data().pending.length}>
                  <h2>Pending</h2>
                  <div class="card">
                    <div class="daygroup">
                      <For each={data().pending.slice(0, 5)}>{(record) => <PendingRow record={record} />}</For>
                    </div>
                    <Show when={data().pending.length > 5}>
                      <button
                        type="button"
                        class="link"
                        onClick={() => {
                          // All accounts, or Records would show fewer holds than the button promised.
                          setRecordsFilters({ account: 'All', unconfirmedOnly: false });
                          go('records');
                        }}
                      >
                        {'See all ' + data().pending.length + ' in Records'}
                      </button>
                    </Show>
                    <p class="pending-note">Not settled yet, so no total on this screen counts them</p>
                  </div>
                </Show>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
