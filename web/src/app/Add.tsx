/**
 * Add.tsx — cash you spent, and what an asset is worth now.
 *
 * From `page.add.html`. Both are the `cash` write: a revaluation is a
 * transfer into or out of the asset, dated today, under `Transfer ›
 * Valuation change`, for the difference between what the book says and what
 * you typed — so the balance moves and no total calls it spending.
 *
 * **One id per entry, made when the form is drawn and again after each
 * success.** It is what the Worker hashes into the row's uid, so a tap that
 * times out and is tapped again lands once.
 */

import { createSignal, For, Show } from 'solid-js';
import { formatAmount, liveAmount, parseAmount } from './amount';
import { money } from './format';
import { CategoryPicker, LabelChips, type Choice } from './Sheet';
import { currency, formAccount, go, open, overview, toast } from './state';
import { addCash, entryId } from './writes';

const TRANSFER_CATEGORY = 'Transfer';
const VALUATION_SUBCATEGORY = 'Valuation change';

function Back() {
  return (
    <button type="button" class="link" onClick={() => go('dashboard')}>
      ← Home
    </button>
  );
}

/** The later of the phone's day and the book's, as `yyyy-mm-dd` — the most recent day a cash entry can be for. */
function latestToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const phone = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  const book = open()?.generatedAt ?? '';
  return book > phone ? book : phone;
}

export function AddCash() {
  const accounts = () => open()?.lists.cashAccounts ?? [];
  const [direction, setDirection] = createSignal<'expense' | 'income'>('expense');
  const [amount, setAmount] = createSignal('');
  const [account, setAccount] = createSignal(accounts().indexOf(formAccount()) !== -1 ? formAccount() : accounts()[0] ?? '');
  const [choice, setChoice] = createSignal<Choice | null>(null);
  const [labels, setLabels] = createSignal<string[]>([]);
  const [date, setDate] = createSignal(latestToday());
  const [note, setNote] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  // One form, one entry: a retry after a failure sends the same id, and a
  // saved entry closes the form, so the next one opens with a new id.
  const id = entryId();

  const kindOf = (category: string) => overview()?.lists.categories.parents.find((parent) => parent.name === category)?.kind ?? '';
  // A label is an axis over spending; a transfer is in no total a label could filter.
  const isTransfer = () => !!choice() && kindOf(choice()!.category) === 'transfer';

  const save = async () => {
    const typed = parseAmount(amount());
    setSaving(true);
    const ok = await addCash({
      id,
      amount: typed,
      direction: direction(),
      account: account(),
      category: choice()?.category ?? '',
      subcategory: choice()?.subcategory ?? '',
      date: date(),
      note: note(),
      labels: isTransfer() ? [] : labels()
    });
    setSaving(false);
    if (!ok) return;
    // Back to the tile it was added from, which the book's re-read updates.
    // A second entry is one tap on "+ Add" away, and opens a fresh form.
    go('dashboard');
  };

  return (
    <>
      <Back />
      <h1>Add transaction</h1>
      <Show
        when={accounts().length}
        fallback={
          <div class="card">
            <p class="muted">No cash accounts yet. Add a row to the accounts tab with kind set to cash, then reload.</p>
          </div>
        }
      >
        <div class="card">
          <div class="segmented" role="group" aria-label="Expense or income">
            <For
              each={
                [
                  ['expense', 'Expense'],
                  ['income', 'Income']
                ] as ['expense' | 'income', string][]
              }
            >
              {(pair) => (
                <button type="button" class="seg" aria-pressed={direction() === pair[0] ? 'true' : 'false'} onClick={() => setDirection(pair[0])}>
                  {pair[1]}
                </button>
              )}
            </For>
          </div>
          <label>Amount</label>
          <input
            class="field"
            type="text"
            inputmode="decimal"
            placeholder={formatAmount(3.5)}
            ref={liveAmount}
            onInput={(event) => setAmount(event.currentTarget.value)}
          />
          <label>Account</label>
          <select class="field" onChange={(event) => setAccount(event.currentTarget.value)}>
            <For each={accounts()}>
              {(name) => (
                <option value={name} selected={account() === name}>
                  {name}
                </option>
              )}
            </For>
          </select>
          <label>Category</label>
          {/* Keyed on the direction: an income entry picks from income categories, and from nothing an expense chose. */}
          <Show when={direction()} keyed>
            {(which) => (
              <CategoryPicker
                kinds={[which, 'transfer']}
                firstLabel={which === 'income' ? 'Choose a category' : 'Uncategorised'}
                start={{ category: '', subcategory: '' }}
                onPick={setChoice}
              />
            )}
          </Show>
          <Show when={!isTransfer()}>
            <LabelChips current={[]} onChange={setLabels} />
          </Show>
          <label>Date</label>
          <input class="field" type="date" value={date()} max={latestToday()} onInput={(event) => setDate(event.currentTarget.value)} />
          <label>Note</label>
          <input class="field" type="text" onInput={(event) => setNote(event.currentTarget.value)} />
          <button type="button" class="primary" style={{ 'margin-top': '16px' }} disabled={saving()} onClick={() => void save()}>
            {saving() ? 'Adding…' : 'Add'}
          </button>
        </div>
      </Show>
    </>
  );
}

export function SetValue() {
  const assets = () => open()?.lists.assetAccounts ?? [];
  const [account, setAccount] = createSignal(assets().some((entry) => entry.name === formAccount()) ? formAccount() : assets()[0]?.name ?? '');
  const was = () => assets().find((entry) => entry.name === account())?.balance ?? null;
  const [typed, setTyped] = createSignal(formatAmount(was()));
  const [pristine, setPristine] = createSignal(true);
  const [note, setNote] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [id, setId] = createSignal(entryId());
  let valueField: HTMLInputElement | undefined;

  const delta = () => {
    const value = parseAmount(typed());
    return Number.isFinite(value) ? Number((value - (was() ?? 0)).toFixed(2)) : NaN;
  };
  const preview = () => {
    const change = delta();
    if (!Number.isFinite(change)) return '';
    if (change === 0) return pristine() ? 'Edit this to the value it holds now.' : 'That is what it already says — nothing to record.';
    return (change > 0 ? 'Up ' : 'Down ') + money(Math.abs(change), currency()) + ' — recorded as one transaction dated today.';
  };
  const prefill = () => {
    const text = formatAmount(was());
    setTyped(text);
    setPristine(true);
    if (valueField) valueField.value = text;
  };

  const save = async () => {
    const value = parseAmount(typed());
    if (!Number.isFinite(value)) return toast('Type the new value.');
    const change = delta();
    if (change === 0) return toast('That is what it already says.');
    setSaving(true);
    const ok = await addCash({
      id: id(),
      amount: change,
      account: account(),
      category: TRANSFER_CATEGORY,
      subcategory: VALUATION_SUBCATEGORY,
      date: open()?.generatedAt ?? '',
      note: note() || account() + ' revalued to ' + money(value, currency())
    });
    setSaving(false);
    if (!ok) return;
    setId(entryId());
    go('dashboard');
  };

  return (
    <>
      <Back />
      <h1>Update balance</h1>
      <Show
        when={assets().length}
        fallback={
          <div class="card">
            <p class="muted">No asset accounts yet. Add a row to the accounts tab with kind set to asset, then reload.</p>
          </div>
        }
      >
        <div class="card">
          <label>Account</label>
          <select
            class="field"
            onChange={(event) => {
              setAccount(event.currentTarget.value);
              prefill();
            }}
          >
            <For each={assets()}>
              {(entry) => (
                <option value={entry.name} selected={account() === entry.name}>
                  {entry.name}
                </option>
              )}
            </For>
          </select>
          <div class="muted">{was() === null ? 'No value recorded yet.' : 'Currently ' + money(was(), currency())}</div>
          <label>New value</label>
          <input
            class="field"
            type="text"
            inputmode="decimal"
            value={typed()}
            ref={(el) => {
              valueField = el;
              liveAmount(el);
              // Everything selected on focus: the old value is what you are replacing, not what you are editing.
              el.addEventListener('focus', () => setTimeout(() => document.activeElement === el && el.setSelectionRange(0, el.value.length), 0));
            }}
            onInput={(event) => {
              setPristine(false);
              setTyped(event.currentTarget.value);
            }}
          />
          <div class="muted">{preview()}</div>
          <label>Note</label>
          <input class="field" type="text" placeholder="Optional" onInput={(event) => setNote(event.currentTarget.value)} />
          <button
            type="button"
            class="primary"
            style={{ 'margin-top': '16px' }}
            disabled={saving() || delta() === 0}
            onClick={() => void save()}
          >
            {saving() ? 'Recording…' : 'Record the change'}
          </button>
        </div>
      </Show>
    </>
  );
}
