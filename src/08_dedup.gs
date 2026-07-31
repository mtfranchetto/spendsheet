/**
 * 08_dedup.gs — deciding whether we have seen a transaction before.
 *
 * Sync runs nightly and fetches an overlapping window every time, so almost
 * everything it returns is already in the sheet. Getting identity wrong is
 * expensive in both directions: too loose and history grows duplicates that
 * inflate every total, too tight and a real transaction is silently swallowed
 * and never appears at all. The second is worse, because nothing about the
 * sheet looks wrong afterwards.
 *
 * The strong key is `entry_reference`, which the standard says is immutable
 * per account. It is not globally unique and some providers reuse it, so it
 * is always hashed together with the account.
 *
 * When a bank omits it — many do, and it is booked-only everywhere — identity
 * falls back to the transaction's own facts plus an **ordinal**, which is the
 * part that looks unnecessary and is not: two genuine €3 coffees at the same
 * bar on the same day are identical in every field a bank reports. Without a
 * counter they hash the same and one of them silently never existed.
 */

var UID_SEPARATOR = '|';

/**
 * Hex SHA-256.
 *
 * `computeDigest` returns *signed* bytes, so a byte over 127 comes back
 * negative and `toString(16)` on it yields something like `-4d`. The mask is
 * what makes this a hash function rather than a string generator.
 */
function sha256Hex(text) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);

  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var byte = bytes[i] & 0xff;
    out += (byte < 16 ? '0' : '') + byte.toString(16);
  }
  return out;
}

/**
 * A description reduced to what is stable about it.
 *
 * Only ever used as part of a key, so readability does not matter and
 * consistency entirely does: the same transaction must reduce to the same
 * string on every sync, including after a bank changes its spacing or
 * punctuation.
 */
function normalizeDescription(text) {
  return String(text === null || text === undefined ? '' : text)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** `YYYY-MM-DD`, from either a Date or an ISO string, in local terms. */
function dateKey(value) {
  if (!value) return '';
  if (value instanceof Date) {
    var month = value.getMonth() + 1;
    var day = value.getDate();
    return value.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
  }
  var match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return match ? match[1] : String(value);
}

/**
 * Fixed precision, so 3 and 3.00 and "3.0" are one number and not three.
 *
 * A blank is checked before Number(), which would turn it into a confident
 * `0.00` — the same shape of bug as reading a cleared config cell as a
 * deliberate zero, and here it would make an emptied amount cell compare
 * equal to a genuine zero-euro row.
 */
function amountKey(amount) {
  if (isBlankCell_(amount)) return '';

  var parsed = Number(amount);
  return isFinite(parsed) ? parsed.toFixed(2) : '';
}

/** The identity of a record. `ordinal` is ignored when there is a strong key. */
function computeUid(record, ordinal) {
  if (record.entry_reference) {
    return sha256Hex(record.account_id + UID_SEPARATOR + record.entry_reference);
  }
  return sha256Hex([
    record.account_id,
    dateKey(record.booking_date),
    amountKey(record.amount),
    normalizeDescription(record.description),
    ordinal
  ].join(UID_SEPARATOR));
}

/** Everything about a record except which of its identical twins it is. */
function fallbackGroupKey(record) {
  return [
    record.account_id,
    dateKey(record.booking_date),
    amountKey(record.amount),
    normalizeDescription(record.description)
  ].join(UID_SEPARATOR);
}

/**
 * Give every record in a batch its uid.
 *
 * The ordinal counts identical records **within one fetch**, which is stable
 * because a fetch always covers whole days: `date_from` and `date_to` are
 * dates, so a day is either entirely in the window or entirely out of it, and
 * a day that is in it arrives complete. The same day fetched tomorrow
 * therefore produces the same groups in the same order and the same uids.
 *
 * The one case it does not cover: two identical transactions where the second
 * settles later *and* the bank sorts it ahead of the first. The pair then
 * swaps ordinals, so one row inserts twice and the other never matches its
 * earlier self. The count stays right — two coffees, two rows — which is why
 * this is a wrinkle rather than a bug worth carrying state to fix.
 */
function assignUids(records) {
  var seen = {};

  return (records || []).map(function (record) {
    if (record.entry_reference) {
      record.uid = computeUid(record, 0);
      return record;
    }

    var group = fallbackGroupKey(record);
    var ordinal = seen[group] === undefined ? 0 : seen[group] + 1;
    seen[group] = ordinal;
    record.uid = computeUid(record, ordinal);
    return record;
  });
}

/**
 * Split a batch into what is new and what we already hold.
 *
 * `existing` maps uid → {amount, booking_date} for rows already in the sheet.
 * A uid we have seen before whose amount or date has *changed* is not a
 * duplicate and not an insert: it is the same `entry_reference` describing
 * something different, which is a provider bug. Those go to `_anomalies`
 * rather than silently overwriting history — `transactions` is append-only,
 * so nothing here ever rewrites a row that is already there.
 */
function partitionByUid(records, existing) {
  var fresh = [];
  var duplicates = [];
  var conflicts = [];
  var withinBatch = {};

  (records || []).forEach(function (record) {
    var known = existing[record.uid];

    if (!known && !withinBatch[record.uid]) {
      withinBatch[record.uid] = { amount: record.amount, booking_date: record.booking_date };
      fresh.push(record);
      return;
    }

    var previous = known || withinBatch[record.uid];
    if (conflictsWith(previous, record)) conflicts.push({ record: record, previous: previous });
    else duplicates.push(record);
  });

  return { fresh: fresh, duplicates: duplicates, conflicts: conflicts };
}

/** Same identity, different facts. */
function conflictsWith(previous, record) {
  return amountKey(previous.amount) !== amountKey(record.amount) ||
    dateKey(previous.booking_date) !== dateKey(record.booking_date);
}
