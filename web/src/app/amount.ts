/**
 * amount.ts — an amount as a person types it, in the phone's own separators.
 *
 * From `page.core.html`, whose reasoning carries over whole. The field is
 * `inputmode="decimal"`, and iOS shows the locale's decimal key: a comma in
 * Italy. So `3,50` is three euros fifty and `1.250` is twelve hundred and
 * fifty — the last `.` or `,` is the decimal point when it is the locale's
 * own, or when one or two digits follow it; three digits after it read as a
 * thousands group. Either key typed *while typing* becomes the locale's
 * decimal point, because nobody types a grouping separator by hand.
 */

export type Separators = { group: string; decimal: string };

let found: Separators | null = null;

/** The phone's grouping and decimal separators, never the same character. */
export function separators(): Separators {
  if (found) return found;
  const out: Separators = { group: ',', decimal: '.' };
  try {
    for (const part of new Intl.NumberFormat(undefined, { useGrouping: true }).formatToParts(12345.6)) {
      if (part.type === 'group') out.group = part.value;
      if (part.type === 'decimal') out.decimal = part.value;
    }
  } catch {
    // The defaults above.
  }
  if (out.group === out.decimal) out.group = out.decimal === ',' ? '.' : ',';
  found = out;
  return out;
}

type Parts = { sign: string; whole: string; decimals: string; point: boolean };

/** `strict`: only the locale's decimal separator is a point — what a keystroke means. */
function parts(text: string, strict: boolean, sep: Separators): Parts | null {
  const raw = String(text ?? '').trim();
  const sign = /^[-−]/.test(raw) ? '-' : '';
  let at = -1;
  if (strict) {
    at = raw.indexOf(sep.decimal);
  } else {
    const last = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf(','));
    if (last !== -1) {
      const after = raw.slice(last + 1).replace(/\D/g, '').length;
      if (raw.charAt(last) === sep.decimal || (after > 0 && after < 3)) at = last;
    }
  }
  const whole = (at === -1 ? raw : raw.slice(0, at)).replace(/\D/g, '');
  const decimals = at === -1 ? '' : raw.slice(at + 1).replace(/\D/g, '').slice(0, 2);
  if (!sign && !whole && at === -1) return null;
  return { sign, whole, decimals, point: at !== -1 };
}

function asText(p: Parts | null, sep: Separators): string {
  if (!p) return '';
  let whole = p.whole.replace(/^0+(?=\d)/, '');
  if (!whole && p.point) whole = '0';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, () => sep.group);
  return p.sign + grouped + (p.point ? sep.decimal + p.decimals : '');
}

/** What was typed, as a number, or NaN. */
export function parseAmount(text: string, sep: Separators = separators()): number {
  const p = parts(text, false, sep);
  if (!p || (!p.whole && !p.decimals)) return NaN;
  return Number(p.sign + (p.whole || '0') + '.' + (p.decimals || '0'));
}

/** A number as the field shows it: grouped, two decimals, the phone's separators. */
export function formatAmount(value: number | null | undefined, sep: Separators = separators()): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return asText(parts(value.toFixed(2), false, sep), sep);
}

/**
 * Regroup the field as it is typed, keeping the caret beside the same digit.
 *
 * Deleting a separator deletes the digit next to it instead — otherwise
 * backspace over `1.250` would remove the `.`, the regroup would put it back,
 * and the key would appear to do nothing.
 */
export function liveAmount(input: HTMLInputElement): void {
  let before = '';
  input.addEventListener('beforeinput', () => {
    before = input.value;
  });
  const meaningful = (text: string, sep: Separators) => [...text].filter((ch) => /\d/.test(ch) || ch === sep.decimal).length;

  input.addEventListener('input', (event) => {
    const sep = separators();
    const typed = event as InputEvent;
    let text = input.value;
    let caret = input.selectionStart === null ? text.length : input.selectionStart;

    if ((typed.data === '.' || typed.data === ',') && caret > 0) {
      text = text.slice(0, caret - 1) + sep.decimal + text.slice(caret);
    }
    const kind = typed.inputType || '';
    if (kind.indexOf('delete') === 0 && before && text.length < before.length && meaningful(text, sep) === meaningful(before, sep)) {
      const backward = kind === 'deleteContentBackward';
      let gone = backward ? caret - 1 : caret;
      while (gone >= 0 && gone < text.length && !(/\d/.test(text.charAt(gone)) || text.charAt(gone) === sep.decimal)) {
        gone += backward ? -1 : 1;
      }
      if (gone >= 0 && gone < text.length) {
        text = text.slice(0, gone) + text.slice(gone + 1);
        if (backward) caret = gone;
      }
    }
    const typing = !kind || kind.indexOf('insertFromPaste') === -1;
    const right = [...text.slice(caret)].filter((ch) => /\d/.test(ch) || ch === sep.decimal).length;
    const formatted = asText(parts(text, typing, sep), sep);
    if (formatted === input.value) return;
    input.value = formatted;
    if (document.activeElement !== input) return;
    let at = formatted.length;
    let seen = 0;
    while (at > 0 && seen < right) {
      at--;
      if (/\d/.test(formatted.charAt(at)) || formatted.charAt(at) === sep.decimal) seen++;
    }
    input.setSelectionRange(at, at);
  });
}
