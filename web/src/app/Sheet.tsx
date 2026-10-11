/**
 * Sheet.tsx — a row's details, and a rule made from one.
 *
 * One `<dialog>` for both, opened by `openSheet` in
 * `state.ts` and keyed on which row and which sheet — so a write landing
 * while it is open redraws the row underneath without resetting what you
 * have typed into it.
 *
 * What each control sends is decided here and **re-asked by the Worker**:
 * the description field appears only for a row whose description is not the
 * bank's, the amount only for cash you typed and did not pair, delete only
 * for cash — and the Worker refuses each of them anyway for any other row,
 * because a page can send anything.
 */

import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { TRANSFER_OUTSIDE } from '../api/contract';
import { recordForPage, transferPeers, type LedgerRow, type PageRecord } from '../domain/query';
import { TX_TYPE } from '../domain/schema';
import { formatAmount, liveAmount, parseAmount } from './amount';
import { money, shortDate, withIcon } from './format';
import { categoryIcon, subcategoryIcon } from './Rows';
import { book, closeSheet, currency, open, openSheet, overview, sheet, toast } from './state';
import { addRule, deleteRecord, markTransfer, sendDecision, type DecisionFields } from './writes';

type Kind = 'expense' | 'income' | 'transfer';
type Suggestion = { category: string; subcategory: string; from: string } | null;

// ---------------------------------------------------------------------------
// Shared parts
// ---------------------------------------------------------------------------

const fold = (value: string) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

export type Choice = { category: string; subcategory: string };

/**
 * The category picker: a button showing the choice, opening a searchable list
 * grouped by parent. A `<select>` of seventy entries is not a list you pick
 * from — it is one you give up on, and `Transfer` was unfindable in it.
 * Searching matches a parent's name (all of it) or a child's.
 */
export function CategoryPicker(props: {
  kinds?: string[];
  firstLabel: string;
  start: Choice;
  onPick: (choice: Choice | null) => void;
}) {
  const lists = () => overview()?.lists.categories ?? { parents: [], children: [] };
  const initial = (() => {
    const { category, subcategory } = props.start;
    if (!category) return '';
    if (subcategory && lists().children.some((child) => child.name === subcategory && child.parent === category)) {
      return 'c:' + subcategory;
    }
    return 'p:' + category;
  })();
  const [value, setValue] = createSignal(initial);
  const [opened, setOpened] = createSignal(false);
  const [query, setQuery] = createSignal('');
  let search: HTMLInputElement | undefined;
  let current: HTMLButtonElement | undefined;

  const groups = createMemo(() => {
    const wanted = props.kinds ?? [];
    return lists()
      .parents.filter((parent) => !wanted.length || !parent.kind || wanted.indexOf(parent.kind) !== -1)
      .map((parent) => ({
        name: parent.name,
        icon: parent.icon,
        key: fold(parent.name),
        options: [
          { value: 'p:' + parent.name, text: 'Anything in ' + parent.name, key: '' },
          ...lists()
            .children.filter((child) => child.parent === parent.name)
            .map((child) => ({ value: 'c:' + child.name, text: withIcon(child.icon, child.name), key: fold(child.name) }))
        ]
      }));
  });
  const shown = createMemo(() => {
    const q = fold(query().trim());
    return groups()
      .map((group) => ({
        ...group,
        options: !q || group.key.indexOf(q) !== -1 ? group.options : group.options.filter((entry) => entry.key && entry.key.indexOf(q) !== -1)
      }))
      .filter((group) => group.options.length);
  });

  const chosen = (picked: string): Choice | null => {
    if (!picked) return null;
    if (picked.startsWith('p:')) return { category: picked.slice(2), subcategory: '' };
    const child = lists().children.find((entry) => entry.name === picked.slice(2));
    return { category: child ? child.parent : '', subcategory: picked.slice(2) };
  };
  const label = () => {
    const picked = chosen(value());
    if (!picked) return props.firstLabel;
    return picked.subcategory
      ? withIcon(subcategoryIcon(picked.subcategory), picked.subcategory)
      : withIcon(categoryIcon(picked.category), picked.category);
  };
  const pick = (picked: string) => {
    setValue(picked);
    setOpened(false);
    current?.focus();
    props.onPick(chosen(picked));
  };

  return (
    <div class="catpick">
      <button
        type="button"
        class={['field', 'catpick-current', { unset: !value() }]}
        aria-expanded={opened() ? 'true' : 'false'}
        ref={(el) => (current = el)}
        onClick={() => {
          if (opened()) return setOpened(false);
          setQuery('');
          setOpened(true);
          queueMicrotask(() => search?.focus());
        }}
      >
        {label()}
      </button>
      <div class="catpick-panel" hidden={!opened()}>
        <input
          class="field"
          type="search"
          placeholder="Search categories"
          autocomplete="off"
          aria-label="Search categories"
          ref={(el) => (search = el)}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              const first = shown()[0]?.options[0];
              if (first) pick(first.value);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setOpened(false);
              current?.focus();
            }
          }}
        />
        <div class="catpick-list" role="listbox">
          <Show when={!query().trim()}>
            <button type="button" role="option" class="catpick-option first" aria-selected={value() === '' ? 'true' : 'false'} onClick={() => pick('')}>
              {props.firstLabel}
            </button>
          </Show>
          <For each={shown()}>
            {(group) => (
              <>
                <div class="catpick-group">{withIcon(group.icon, group.name)}</div>
                <For each={group.options}>
                  {(entry) => (
                    <button
                      type="button"
                      role="option"
                      class="catpick-option"
                      aria-selected={entry.value === value() ? 'true' : 'false'}
                      onClick={() => pick(entry.value)}
                    >
                      {entry.text}
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
        <Show when={!shown().length}>
          <p class="muted">No category matches that.</p>
        </Show>
      </div>
    </div>
  );
}

/** The book's labels as chips, plus any the row carries that the tab no longer lists. */
export function LabelChips(props: { current: string[]; onChange: (labels: string[]) => void }) {
  const offered = () => {
    const out: string[] = [];
    for (const name of [...(overview()?.lists.labels ?? []), ...props.current]) if (name && out.indexOf(name) === -1) out.push(name);
    return out;
  };
  const [picked, setPicked] = createSignal<string[]>(props.current.slice());
  const toggle = (name: string) => {
    const next = picked().indexOf(name) === -1 ? [...picked(), name] : picked().filter((entry) => entry !== name);
    // In the tab's order, as the `.gs` stores them.
    const ordered = offered().filter((entry) => next.indexOf(entry) !== -1);
    setPicked(ordered);
    props.onChange(ordered);
  };
  return (
    <div>
      <label>Labels</label>
      <Show when={offered().length} fallback={<p class="muted">No labels yet. Add rows to the labels tab.</p>}>
        <div class="chips">
          <For each={offered()}>
            {(name) => (
              <button type="button" class="chip" aria-pressed={picked().indexOf(name) !== -1 ? 'true' : 'false'} onClick={() => toggle(name)}>
                {name}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function TypeTabs(props: { current: Kind; onChange: (kind: Kind) => void; kinds?: [Kind, string][] }) {
  const kinds = () =>
    props.kinds ?? [
      ['expense', 'Expense'],
      ['income', 'Income'],
      ['transfer', 'Transfer']
    ];
  return (
    <div class="segmented" role="group" aria-label="What kind of transaction this is">
      <For each={kinds()}>
        {(pair) => (
          <button type="button" class="seg" aria-pressed={pair[0] === props.current ? 'true' : 'false'} onClick={() => props.onChange(pair[0])}>
            {pair[1]}
          </button>
        )}
      </For>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A row's details
// ---------------------------------------------------------------------------

function kindOfRecord(record: PageRecord): Kind {
  if (record.type === TX_TYPE.TRANSFER) return 'transfer';
  if (record.type === 'income' || record.type === 'expense') return record.type;
  return record.amount !== null && record.amount > 0 ? 'income' : 'expense';
}

function Detail(props: { record: PageRecord; suggestion: Suggestion }) {
  const record = props.record;
  const was = kindOfRecord(record);
  const [kind, setKind] = createSignal<Kind>(was);
  const [description, setDescription] = createSignal(record.description || '');
  const storedSize = record.rawAmount === null ? NaN : Math.abs(Number(record.rawAmount));
  const [amountText, setAmountText] = createSignal(Number.isFinite(storedSize) ? formatAmount(storedSize) : '');
  const [armed, setArmed] = createSignal(false);

  const renamed = () => {
    if (!record.editableDescription) return undefined;
    const typed = description().trim();
    return !typed || typed === (record.description || '') ? undefined : typed;
  };
  /** How much, never which way: `editedAmount_` keeps the stored sign. */
  const resized = (): { amount?: number; problem?: string } => {
    if (!record.editableAmount) return {};
    const typed = parseAmount(amountText());
    if (!Number.isFinite(typed)) return { problem: 'Type an amount.' };
    if (typed < 0) return { problem: 'Type the amount without a sign.' };
    if (Number(typed.toFixed(2)) === 0) return { problem: 'A zero-euro transaction is not a transaction.' };
    if (Number.isFinite(storedSize) && typed.toFixed(2) === storedSize.toFixed(2)) return {};
    return { amount: typed };
  };

  return (
    <>
      <h2>{record.description || '(no description)'}</h2>
      <p class="muted">
        {shortDate(record.date) + (record.time ? ' ' + record.time : '') + ' · ' + record.account + ' · ' + money(record.amount, currency())}
      </p>

      <Show when={record.editableDescription}>
        <label>Description</label>
        <input class="field" type="text" value={description()} onInput={(event) => setDescription(event.currentTarget.value)} />
      </Show>
      <Show when={record.editableAmount}>
        <label>Amount</label>
        <input
          class="field"
          type="text"
          inputmode="decimal"
          value={amountText()}
          ref={(el) => liveAmount(el)}
          onInput={(event) => setAmountText(event.currentTarget.value)}
        />
        <div class="muted">How much, not which way — the direction stays as it is.</div>
      </Show>

      <TypeTabs current={kind()} onChange={setKind} />
      <Switch>
        <Match when={kind() === 'transfer'}>
          <TransferPane record={record} was={was} renamed={renamed} resized={resized} />
        </Match>
        <Match when={kind() !== 'transfer'}>
          <CategoryPane record={record} kind={kind() as 'expense' | 'income'} was={was} suggestion={props.suggestion} renamed={renamed} resized={resized} />
        </Match>
      </Switch>

      <button type="button" class="link" style={{ 'margin-top': '12px' }} onClick={() => openSheet('rule', record.uid)}>
        Always categorise this…
      </button>

      <Show when={record.deletable}>
        <div class="danger-zone">
          {/* Two steps, and the first stays armed: no clock undoes a choice you are in the middle of making. */}
          <button
            type="button"
            class={['danger', { armed: armed() }]}
            onClick={() => {
              if (!armed()) return setArmed(true);
              closeSheet();
              void deleteRecord(record);
            }}
          >
            {armed() ? 'Tap again to delete' : 'Delete'}
          </button>
          <Show when={armed()}>
            <p class="muted">A copy is kept on the _removed tab.</p>
          </Show>
        </div>
      </Show>
    </>
  );
}

type Edits = { renamed: () => string | undefined; resized: () => { amount?: number; problem?: string } };

function CategoryPane(props: { record: PageRecord; kind: 'expense' | 'income'; was: Kind; suggestion: Suggestion } & Edits) {
  const record = props.record;
  const moving = props.was === 'transfer';
  // A suggestion stands in only for a row the cascade could not file.
  const suggestion = !record.category && !moving ? props.suggestion : null;
  const start = suggestion ?? { category: record.category, subcategory: record.subcategory };
  const [choice, setChoice] = createSignal<Choice | null>(start.category ? start : null);
  const [labels, setLabels] = createSignal<string[]>(record.labels.slice());

  const save = () => {
    if (moving && !choice()) return toast('Pick the category it should be instead.');
    const resized = props.resized();
    if (resized.problem) return toast(resized.problem);
    const decision: DecisionFields = { confirmed: true, labels: labels() };
    const picked = choice();
    if (picked) {
      decision.category_override = picked.category;
      if (picked.subcategory) decision.subcategory_override = picked.subcategory;
    }
    if (resized.amount !== undefined) decision.amount = resized.amount;
    const renamed = props.renamed();
    if (renamed) decision.description = renamed;
    closeSheet();
    sendDecision(record, decision);
  };

  return (
    <>
      <p class="muted">
        {record.category
          ? 'Currently ' +
            withIcon(categoryIcon(record.category), record.category) +
            (record.subcategory ? ' › ' + withIcon(subcategoryIcon(record.subcategory), record.subcategory) : '') +
            (record.source ? ' (' + record.source + ')' : '')
          : 'Not categorised.'}
      </p>
      <CategoryPicker kinds={[props.kind]} firstLabel={moving ? 'Pick a category…' : 'Leave as it is'} start={start} onPick={setChoice} />
      <Show when={suggestion && choice()}>
        <p class="muted suggested">{'Suggested from “' + suggestion!.from + '”.'}</p>
      </Show>
      <LabelChips current={record.labels} onChange={setLabels} />
      <button type="button" class="primary" style={{ 'margin-top': '16px' }} onClick={save}>
        {record.confirmed ? 'Save' : 'Confirm'}
      </button>
    </>
  );
}

function TransferPane(props: { record: PageRecord; was: Kind } & Edits) {
  const record = props.record;
  const accounts = () => (open()?.lists.accounts ?? []).filter((name) => name !== record.account);
  const kinds = () => (overview()?.lists.categories.children ?? []).filter((child) => child.kind === TX_TYPE.TRANSFER);
  const [destination, setDestination] = createSignal(record.peerAccount || TRANSFER_OUTSIDE);
  const [subcategory, setSubcategory] = createSignal(
    kinds().find((child) => child.name === record.subcategory)?.name ?? kinds()[0]?.name ?? ''
  );

  const save = () => {
    const resized = props.resized();
    if (resized.problem) return toast(resized.problem);
    const renamed = props.renamed();
    closeSheet();
    void markTransfer(record, {
      destination: destination(),
      subcategory: subcategory(),
      ...(resized.amount !== undefined ? { amount: resized.amount } : {}),
      ...(renamed ? { description: renamed } : {})
    });
  };

  return (
    <>
      <p class="muted">Money between accounts you own. Not income, not spending, and counted in neither.</p>
      <label>{record.peerDirection === 'from' ? 'Where did it come from?' : 'Where did it go?'}</label>
      <select class="field" onChange={(event) => setDestination(event.currentTarget.value)}>
        <option value={TRANSFER_OUTSIDE} selected={destination() === TRANSFER_OUTSIDE}>
          Somewhere outside Spendsheet
        </option>
        <For each={accounts()}>
          {(name) => (
            <option value={name} selected={destination() === name}>
              {name}
            </option>
          )}
        </For>
      </select>
      <div class="muted">
        Both balances move. A cash or asset account gets the other half written for it; a bank is matched against the row it already reported, or as
        soon as it does.
      </div>
      <Show when={kinds().length}>
        <label style={{ 'margin-top': '12px' }}>What kind of move?</label>
        <select class="field" onChange={(event) => setSubcategory(event.currentTarget.value)}>
          <For each={kinds()}>
            {(child) => (
              <option value={child.name} selected={subcategory() === child.name}>
                {withIcon(child.icon, child.name)}
              </option>
            )}
          </For>
        </select>
      </Show>
      <button type="button" class="primary" style={{ 'margin-top': '16px' }} onClick={save}>
        {props.was === 'transfer' ? 'Save' : 'Mark as a transfer'}
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// A rule from a row
// ---------------------------------------------------------------------------

const MATCHES: [string, string][] = [
  ['contains', 'contains it'],
  ['equals', 'is exactly it'],
  ['starts_with', 'starts with it'],
  ['regex', 'matches it as a pattern']
];

function RuleForm(props: { record: PageRecord }) {
  const record = props.record;
  const [pattern, setPattern] = createSignal(record.merchantKey || record.description || '');
  const [how, setHow] = createSignal('contains');
  const [choice, setChoice] = createSignal<Choice | null>(record.category ? { category: record.category, subcategory: record.subcategory } : null);
  const [saving, setSaving] = createSignal(false);

  const save = async () => {
    const picked = choice();
    setSaving(true);
    const ok = await addRule({
      field: 'description',
      match_type: how(),
      pattern: pattern(),
      category: picked?.category ?? '',
      subcategory: picked?.subcategory ?? ''
    });
    setSaving(false);
    if (ok) closeSheet();
  };

  return (
    <>
      <h2>Always categorise this</h2>
      <p class="muted">{record.description || '(no description)'}</p>
      <label>When the description contains</label>
      <input class="field" type="text" value={pattern()} onInput={(event) => setPattern(event.currentTarget.value)} />
      <label>Match</label>
      <select class="field" onChange={(event) => setHow(event.currentTarget.value)}>
        <For each={MATCHES}>
          {(pair) => (
            <option value={pair[0]} selected={how() === pair[0]}>
              {pair[1]}
            </option>
          )}
        </For>
      </select>
      <label>File it under</label>
      <CategoryPicker firstLabel="Choose a category" start={{ category: record.category, subcategory: record.subcategory }} onPick={setChoice} />
      <button type="button" class="primary" style={{ 'margin-top': '16px' }} disabled={saving()} onClick={() => void save()}>
        {saving() ? 'Saving…' : 'Save rule'}
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

/**
 * `showModal` with the page held still behind it: iOS scrolls the document
 * to the focused field otherwise, and closing leaves you somewhere else in
 * the list than where you opened it.
 */
function openWithoutMoving(dialog: HTMLDialogElement): () => void {
  const at = window.scrollY;
  const style = document.body.style;
  style.position = 'fixed';
  style.top = -at + 'px';
  style.left = '0';
  style.right = '0';
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    style.position = '';
    style.top = '';
    style.left = '';
    style.right = '';
    window.scrollTo(0, at);
  };
  dialog.addEventListener('close', release, { once: true });
  dialog.showModal();
  return release;
}

/**
 * A sheet from the bottom, up while `open` is true. Closing it by its ✕, by
 * Escape or by a tap on the backdrop all arrive at `onClose`.
 *
 * The page is let go on cleanup as well as on `close`: a dialog taken out of
 * the document while it is up — the screen it belongs to going away under it
 * — fires no `close`, and would leave the page pinned where it was.
 */
export function Dialog(props: { id?: string; open: boolean; onClose: () => void; children: JSX.Element }) {
  let dialog: HTMLDialogElement | undefined;
  let release: (() => void) | undefined;

  createEffect(
    () => props.open,
    (showing) => {
      if (!dialog) return;
      if (showing && !dialog.open) release = openWithoutMoving(dialog);
      if (!showing && dialog.open) dialog.close();
    }
  );
  onCleanup(() => release?.());

  return (
    <dialog
      id={props.id}
      ref={(el) => (dialog = el)}
      onClose={() => props.onClose()}
      onClick={(event) => {
        if (event.target === dialog) props.onClose();
      }}
    >
      {/* First in the markup: `showModal` focuses the first thing it can — see `.sheet-close`. */}
      <button type="button" class="sheet-close" autofocus aria-label="Close" onClick={() => props.onClose()}>
        ✕
      </button>
      <div class="sheet-body">{props.children}</div>
    </dialog>
  );
}

export function SheetHost() {

  // The row the sheet is about, drawn from the book as it is now — a write
  // landing while it is open redraws it.
  const peers = createMemo(() => transferPeers(book()?.transactions ?? []));
  const target = createMemo(() => {
    const current = sheet();
    const b = book();
    if (!current || !b) return null;
    const row = b.transactions.find((entry) => String(entry.uid) === current.uid) as LedgerRow | undefined;
    return row ? recordForPage(row, peers(), b.timeZone) : null;
  });
  const suggestion = () => {
    const current = sheet();
    const queued = overview()?.review.find((entry) => entry.uid === current?.uid) as { suggestion?: Suggestion } | undefined;
    return queued?.suggestion ?? null;
  };
  // Keyed on which sheet for which row, so nothing typed is lost to a redraw.
  const key = () => {
    const current = sheet();
    return current && target() ? current.kind + ':' + current.uid : null;
  };

  return (
    <Dialog id="sheet" open={!!key()} onClose={closeSheet}>
      <Show when={key()} keyed>
        {(which) => (which.startsWith('rule:') ? <RuleForm record={target()!} /> : <Detail record={target()!} suggestion={suggestion()} />)}
      </Show>
    </Dialog>
  );
}
