/**
 * 07_transactions.gs — turning what a bank returns into a row.
 *
 * Pure functions only: no sheet, no network, no clock beyond what is passed
 * in. Everything here is a shape problem, and shape problems are where this
 * kind of system goes quietly wrong — a field read under the wrong name gives
 * `undefined`, which lands in the sheet as a blank cell rather than as an
 * error, and blank cells do not look like bugs.
 *
 * Two of those traps are worth stating outright.
 *
 * **The sign is not in the amount.** `transaction_amount.amount` is an
 * unsigned *string*; direction lives in `credit_debit_indicator`. Multiplying
 * a naively-parsed amount by a sign double-negates the day a provider sends
 * `"-12.34"` with `DBIT`, turning an expense into income — which inverts every
 * total in the sheet while looking perfectly plausible.
 *
 * **The aggregation API is snake_case.** Enable Banking publishes a second,
 * separate self-hosted TPP API whose documentation is camelCase. Reading the
 * wrong set gives code that compiles, runs, and reads `undefined` from every
 * field.
 */

var TX_SOURCE_API = 'enablebanking';

/**
 * A provider transaction as a row object, keyed by column name.
 *
 * `uid` is deliberately absent — identity is 08_dedup's job, and it needs the
 * whole batch to compute an ordinal.
 */
function mapTransaction(raw, account, now) {
  var amount = signedAmount(raw);

  return {
    account_id: account.uid,
    account_name: account.name || '',
    booking_date: parseIsoDate(raw.booking_date),
    value_date: parseIsoDate(raw.value_date),
    transaction_date: parseIsoDate(raw.transaction_date),
    amount: amount,
    currency: transactionCurrency(raw) || account.currency || '',
    description: transactionDescription(raw),
    counterparty: counterpartyName(raw),
    entry_reference: raw.entry_reference || '',
    bank_transaction_code: bankTransactionCode(raw),
    mcc: raw.merchant_category_code || '',
    source: TX_SOURCE_API,
    imported_at: now,

    // Not columns. Carried alongside so the caller can route and explain a
    // row without going back to the raw response.
    _status: raw.status || '',
    _amountReadable: amount !== null,
    _indicator: raw.credit_debit_indicator || ''
  };
}

/**
 * Direction comes from `credit_debit_indicator`, applied to the magnitude.
 *
 * When the indicator is missing entirely the amount's own sign is the only
 * information there is, so it is used as-is rather than assumed to be income.
 * Callers flag that case: a provider that omits direction is telling us
 * something about itself worth recording.
 */
function signedAmount(raw) {
  var money = raw && raw.transaction_amount;
  var parsed = parseFloat(money && money.amount !== undefined && money.amount !== null
    ? money.amount : NaN);
  if (!isFinite(parsed)) return null;

  var magnitude = Math.abs(parsed);
  if (raw.credit_debit_indicator === CREDIT_DEBIT.DEBIT) return -magnitude;
  if (raw.credit_debit_indicator === CREDIT_DEBIT.CREDIT) return magnitude;
  return parsed;
}

function transactionCurrency(raw) {
  var money = raw && raw.transaction_amount;
  return (money && money.currency) || '';
}

/**
 * A date the spreadsheet will treat as a date.
 *
 * Built from the parts rather than handed to `new Date(string)`: that parses
 * a bare `YYYY-MM-DD` as UTC midnight, which is the previous day in every
 * timezone west of Greenwich. A booking date that silently shifts by one day
 * is the sort of error you find months later in a monthly total.
 */
function parseIsoDate(text) {
  if (!text) return '';
  if (text instanceof Date) return text;

  var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text));
  if (!match) return '';
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * What the row says it was.
 *
 * `remittance_information` is an array and is where the useful text lives for
 * most banks; the rest are fallbacks for the ones that leave it empty. A row
 * with no description at all is still a valid row — it just categorises by
 * MCC or by hand.
 */
function transactionDescription(raw) {
  var parts = raw && raw.remittance_information;
  var text = Array.isArray(parts) ? parts.join(' ') : (parts || '');
  text = String(text).replace(/\s+/g, ' ').trim();
  if (text) return text;

  var code = raw && raw.bank_transaction_code;
  return String(raw.note || (code && code.description) || counterpartyName(raw) || '').trim();
}

/**
 * The other party — whoever is not you.
 *
 * Which side that is depends on the direction: money out means the creditor
 * is the merchant, money in means the debtor is the payer. Getting this
 * backwards fills the column with your own name, which reads as working right
 * up until you try to categorise by it.
 */
function counterpartyName(raw) {
  if (!raw) return '';
  var outgoing = raw.credit_debit_indicator === CREDIT_DEBIT.DEBIT;
  var party = outgoing ? raw.creditor : raw.debtor;
  var account = outgoing ? raw.creditor_account : raw.debtor_account;

  return partyName_(party) || accountIdentifier_(account) || '';
}

function partyName_(party) {
  if (!party) return '';
  if (typeof party === 'string') return party;
  return String(party.name || '').trim();
}

function accountIdentifier_(account) {
  if (!account) return '';
  if (typeof account === 'string') return account;
  return String(account.iban || (account.other && account.other.identification) || '').trim();
}

/**
 * The bank's own classification code.
 *
 * Providers use either the ISO 20022 domain/family/sub-family triple or a
 * flat code/sub-code pair, so both are flattened into one readable string.
 * Kept because it is the one classification signal that survives a bank
 * rewording its descriptors.
 */
function bankTransactionCode(raw) {
  var code = raw && raw.bank_transaction_code;
  if (!code) return '';
  if (typeof code === 'string') return code;

  var parts = [code.domain, code.family, code.sub_family, code.code, code.sub_code]
    .filter(function (part) { return part; });
  return parts.length ? parts.join('/') : String(code.description || '');
}

/**
 * Map a batch, keeping only what can be trusted.
 *
 * A transaction whose amount will not parse is not written: a row with a
 * blank amount sums as zero and disappears into a total. It goes to
 * `_anomalies` instead, where it can be looked at.
 */
function mapTransactions(rawList, account, now) {
  var mapped = [];
  var skipped = [];
  var missingIndicator = 0;

  (rawList || []).forEach(function (raw) {
    var record = mapTransaction(raw || {}, account, now);
    if (!record._amountReadable) {
      skipped.push(raw);
      return;
    }
    if (!record._indicator) missingIndicator++;
    mapped.push(record);
  });

  return { records: mapped, skipped: skipped, missingIndicator: missingIndicator };
}

/** Only BOOK rows are allowed into `transactions` — see 09_sync. */
function isBooked(record) {
  return String(record._status || '').toUpperCase() === TX_STATUS.BOOKED;
}
