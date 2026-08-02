/**
 * 06_accounts.gs — what a connection *is*, once the browser round-trip in
 * 05_auth.gs has finished.
 *
 * A session from Enable Banking is a bundle of three separate things, and
 * they land in two different tabs:
 *
 *   the consent  → `_status`   (one row per connection, with its expiry)
 *   the accounts → `accounts`  (one row each, joined back by connection_id)
 *   the balances → `accounts`  (refreshed on every sync, not at connection)
 *
 * Everything here is idempotent. Reconnecting a bank, refreshing accounts and
 * a nightly sync all funnel through the same upserts, because a bank
 * re-exposing an account it already exposed must not produce a second row —
 * and a name you typed must survive all three.
 */

// ---------------------------------------------------------------------------
// Recording a connection
// ---------------------------------------------------------------------------

/**
 * Write the session to _status and its accounts to the accounts tab.
 *
 * `fallbackSessionId` exists because the two ways in disagree about the
 * response. `POST /sessions` echoes the id it just minted; `GET /sessions/{id}`
 * does not, having been handed it in the path. So a refresh derived an empty
 * id from a perfectly good session — and since an empty key can match no row,
 * every refresh appended another blank-keyed `_status` row instead of
 * updating the one it meant to.
 */
function recordConnection(session, fallbackProvider, fallbackSessionId) {
  var accounts = extractAccounts(session);
  var provider = (session.aspsp && session.aspsp.name) || fallbackProvider || 'unknown';
  var session_id = sessionId(session) || fallbackSessionId || '';
  var connectionId = resolveConnectionId_(session, provider, accounts);

  // A session with no readable accounts means our idea of the response shape
  // is wrong. Keeping the raw response is the difference between a fixable
  // bug and a mystery — this is what _anomalies is for.
  if (!accounts.length) {
    logAnomaly_(ANOMALY_KIND.NO_ACCOUNTS, '',
      'Session created, but no accounts could be read from the response. ' +
      'Keys present: ' + Object.keys(session || {}).join(', '),
      session);
  }

  upsertStatusRow_(mapSessionToStatusRow(session, provider, new Date(), session_id, connectionId));
  var result = upsertAccounts_(enrichAccounts_(accounts), provider, connectionId);

  return {
    provider: provider,
    connectionId: connectionId,
    accountCount: accounts.length,
    accountsAdded: result.added,
    written: result.written
  };
}

/** Providers disagree on the field name; the value is the same thing. */
function sessionId(session) {
  return (session && (session.session_id || session.id)) || '';
}

/**
 * Pull account objects out of a session response.
 *
 * Deliberately tolerant about shape. The session may carry full account
 * resources or bare UID strings depending on the endpoint and the bank, and
 * this is one of the things the provider probe is meant to settle per bank.
 * Anything unrecognisable is preserved rather than dropped, so a wrong guess
 * here shows up as a row to look at instead of a silent absence.
 */
function extractAccounts(session) {
  if (!session) return [];

  // Confirmed against a live session: `accounts` is a list of UID *strings*
  // and the descriptive fields live alongside it in `accounts_data`. Reading
  // only the first gives accounts with no name, currency or IBAN; reading
  // only the second misses any UID the bank listed without details.
  var details = {};
  (session.accounts_data || []).forEach(function (entry) {
    if (entry && entry.uid) details[entry.uid] = entry;
  });

  var uids = [];
  function addUid(uid) {
    if (uid && uids.indexOf(uid) === -1) uids.push(uid);
  }

  (session.accounts || []).forEach(function (entry) {
    if (typeof entry === 'string') addUid(entry);
    else if (entry) addUid(entry.uid || entry.resource_id || entry.identification_hash);
  });
  Object.keys(details).forEach(addUid);

  return uids.map(function (uid) {
    var detail = details[uid] || {};
    var identifiers = detail.account_id || {};
    return {
      uid: uid,
      identityHash: accountIdentityHash(detail),
      name: detail.name || detail.product || detail.details || '',
      currency: detail.currency || '',
      iban: identifiers.iban || (identifiers.other && identifiers.other.identification) || ''
    };
  });
}

/**
 * The one field on an account that survives a new consent.
 *
 * `identification_hash` covers the IBAN *and* the currency, which is what
 * makes it usable: Fineco exposes four accounts on a single IBAN, one per
 * currency pocket, and only the currency separates them.
 *
 * There is deliberately no fallback to `identification_hashes`. That list
 * holds hashes over narrower attribute sets — `[0]` is the IBAN alone, and
 * another is the ASPSP plus the account name — and every one of them is
 * identical across all four of those pockets. Falling back would silently
 * merge four accounts into one, which is worse than having no key at all,
 * because having no key is visible.
 */
function accountIdentityHash(detail) {
  return (detail && detail.identification_hash) || '';
}

/**
 * Fill in names and currencies the session didn't carry.
 *
 * Best-effort by design: this costs one API call per unnamed account, runs
 * only at connection or an explicit refresh, and a provider that doesn't
 * expose details must not turn a working connection into a failure. An
 * account with no name is still an account, and you can type your own —
 * which reconnecting preserves.
 */
function enrichAccounts_(accounts) {
  return accounts.map(function (account) {
    if (account.name && account.currency && account.iban) return account;

    var details;
    try {
      details = ebGetAccountDetails(account.uid);
    } catch (e) {
      return account;
    }

    var merged = mergeAccountDetails(account, details);

    // Details came back but told us nothing we could read — that means the
    // shape isn't what we expect, which is worth capturing rather than
    // shrugging at.
    if (!merged.name && !merged.currency && !merged.iban) {
      logAnomaly_(ANOMALY_KIND.UNMAPPED_COLUMN, account.uid,
        'Account details returned no readable fields. Keys: ' + Object.keys(details || {}).join(', '),
        details);
    }
    return merged;
  });
}

/** Overlay whatever the details response knows, without discarding what we had. */
function mergeAccountDetails(account, details) {
  if (!details) return account;

  var identifiers = details.account_id || {};
  return {
    uid: account.uid,
    // Carried through explicitly: this rebuilds the object rather than
    // patching it, so anything not named here is silently dropped.
    identityHash: account.identityHash || accountIdentityHash(details),
    name: account.name || details.name || details.product || details.details ||
      details.display_name || details.owner_name || '',
    currency: account.currency || details.currency || '',
    iban: account.iban || identifiers.iban ||
      (identifiers.other && identifiers.other.identification) || details.iban || ''
  };
}

/** Show enough of an IBAN to recognise the account, not enough to use it. */
function maskIban(iban) {
  if (!iban) return '';
  var text = String(iban).replace(/\s/g, '');
  if (text.length <= 8) return text;
  return text.slice(0, 4) + '…' + text.slice(-4);
}

// ---------------------------------------------------------------------------
// The accounts tab
// ---------------------------------------------------------------------------

/**
 * Add newly discovered accounts.
 *
 * An account already listed keeps the name you gave it — reconnecting a bank
 * must not undo a rename. Only the bank-owned facts are refreshed.
 */
function upsertAccounts_(accounts, provider, connectionId) {
  var sheet = sheetOrThrow_(TABS.ACCOUNTS);
  var idColumn = colIndex_(ACCOUNT_COLUMNS, 'account_id');
  var placeholder = provider + ' account';
  var added = 0;
  // Each write records where it went and what came back, so "reported
  // success but the sheet is empty" is answerable rather than arguable.
  var written = [];

  accounts.forEach(function (account) {
    var existing = findAccountRow_(sheet, account);
    var row = existing || nextEmptyRow_(sheet, idColumn);

    if (!existing) {
      // Frozen here and never rewritten. Every transaction's uid hashes this
      // in, so changing it would silently re-key the whole history.
      writeCell_(sheet, row, ACCOUNT_COLUMNS, 'account_id', account.uid);
      writeCell_(sheet, row, ACCOUNT_COLUMNS, 'name', account.name || placeholder);
      writeCell_(sheet, row, ACCOUNT_COLUMNS, 'kind', ACCOUNT_KIND.BANK);
      writeCell_(sheet, row, ACCOUNT_COLUMNS, 'include_in_net_worth', true);
      writeCell_(sheet, row, ACCOUNT_COLUMNS, 'active', true);
      added++;
    } else if (account.name) {
      // A name you typed is yours and survives a reconnect. Our own
      // placeholder is not a decision anyone made, so a real name from the
      // provider is allowed to replace it.
      var current = readCell_(sheet, row, ACCOUNT_COLUMNS, 'name');
      if (!current || current === placeholder) {
        writeCell_(sheet, row, ACCOUNT_COLUMNS, 'name', account.name);
      }
    }

    writeCell_(sheet, row, ACCOUNT_COLUMNS, 'provider', provider);
    writeCell_(sheet, row, ACCOUNT_COLUMNS, 'iban_masked', maskIban(account.iban));
    if (account.currency) writeCell_(sheet, row, ACCOUNT_COLUMNS, 'currency', account.currency);
    if (connectionId) writeCell_(sheet, row, ACCOUNT_COLUMNS, 'connection_id', connectionId);

    // The two that move with each consent, while account_id stays put.
    if (account.identityHash) {
      writeCell_(sheet, row, ACCOUNT_COLUMNS, 'identity_hash', account.identityHash);
    }
    writeCell_(sheet, row, ACCOUNT_COLUMNS, 'provider_account_id', account.uid);

    written.push({
      uid: account.uid,
      row: row,
      existed: Boolean(existing),
      readBack: sheet.getRange(row, idColumn).getValue()
    });
  });

  return { added: added, written: written };
}


/**
 * The row this account already occupies, if any.
 *
 * Three ways in, most durable first:
 *
 * 1. **`identity_hash`** — the provider's own, stable across consents. This
 *    is what makes a reconnect update a row rather than add one.
 * 2. **`provider_account_id`** — the uid of the current consent. Catches a
 *    row written before identity_hash existed, on the run that backfills it.
 * 3. **`account_id`** — the frozen original. Same purpose, for a sheet whose
 *    rows predate column R entirely.
 *
 * The last two exist only so an existing sheet upgrades itself on the next
 * refresh instead of needing a migration.
 */
function findAccountRow_(sheet, account) {
  var byHash = account.identityHash &&
    findRowByValue_(sheet, colIndex_(ACCOUNT_COLUMNS, 'identity_hash'), account.identityHash);
  if (byHash) return byHash;

  var byProvider = findRowByValue_(
    sheet, colIndex_(ACCOUNT_COLUMNS, 'provider_account_id'), account.uid);
  if (byProvider) return byProvider;

  return findRowByValue_(sheet, colIndex_(ACCOUNT_COLUMNS, 'account_id'), account.uid);
}

/**
 * The accounts a sync should visit.
 *
 * `cash` and `asset` rows are excluded because nothing upstream knows about
 * them: their balances come from your own entries and from you typing a
 * number. `active` is the switch for a bank account you have closed but whose
 * history you want to keep.
 */
function listSyncableAccounts_() {
  return readRecords_(sheetOrThrow_(TABS.ACCOUNTS), ACCOUNT_COLUMNS)
    .filter(function (row) {
      return row.account_id && row.kind === ACCOUNT_KIND.BANK && isTruthyCell_(row.active);
    })
    .map(function (row) {
      return {
        // `uid` is the frozen local identity: what transactions reference and
        // what computeUid hashes. `providerUid` is what the API answers to,
        // and it changes with every consent. Confusing the two either re-keys
        // your history or calls the bank with an id it has forgotten.
        uid: String(row.account_id),
        providerUid: String(row.provider_account_id || row.account_id),
        identityHash: row.identity_hash || '',
        name: row.name || String(row.account_id),
        currency: row.currency || '',
        connectionId: row.connection_id || '',
        row: row._row
      };
    });
}

/**
 * Re-read every live session and rewrite what it says about accounts.
 *
 * Useful beyond first connection: a bank can expose an account later, or
 * change what it reports about one, and neither should require redoing SCA.
 * Names you have given accounts are preserved, as on any reconnect.
 */
function refreshAccounts() {
  var status = sheetOrThrow_(TABS.STATUS);
  var ids = readColumn_(status, colIndex_(STATUS_COLUMNS, 'session_id'))
    .filter(function (id) { return id; });
  if (!ids.length) throw new Error('No connections in _status yet.');

  var total = 0;
  var failures = [];
  var trace = [];

  ids.forEach(function (id) {
    try {
      var summary = recordConnection(ebGetSession(id), null, id);
      total += summary.accountCount;
      trace.push({ sessionId: id, summary: summary });
    } catch (e) {
      failures.push(String(id).slice(0, 8) + '…: ' + e.message);
      trace.push({ sessionId: id, error: e.message, stack: e.stack });
    }
  });

  // Only worth recording when something looks wrong. A row far below the
  // records that precede it means an append went astray — the failure that
  // hid an account at row 1001 while every run reported success.
  var suspicious = failures.length > 0 || trace.some(function (entry) {
    return (entry.summary && entry.summary.written || []).some(function (write) {
      return String(write.readBack) !== String(write.uid) || write.row > MAX_PLAUSIBLE_ACCOUNTS;
    });
  });
  if (suspicious) logAnomaly_(ANOMALY_KIND.RAW_DUMP, '', 'refreshAccounts trace', trace);

  var message = total + ' account' + (total === 1 ? '' : 's') + ' across ' + ids.length + ' connection' +
    (ids.length === 1 ? '' : 's') + (failures.length ? '. Failed: ' + failures.join(' | ') : '');
  SpreadsheetApp.getActiveSpreadsheet().toast(message, 'Accounts refreshed', 10);
  return { accounts: total, connections: ids.length, failures: failures };
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/**
 * The signed value of one Balance object.
 *
 * A Balance carries its own `credit_debit_indicator`, independently of the
 * one on a transaction, and it is the second place the same sign bug can
 * hide: an overdrawn account whose indicator is ignored reads as positive and
 * inflates net worth by twice the overdraft. `Math.abs` first, so a provider
 * that also sends a minus sign cannot double-negate it back to positive.
 */
function balanceAmount(balance) {
  // Written as a guard rather than a ternary because the ternary form derefed
  // a null `balance_amount`: `(raw && raw.amount) !== undefined` is true when
  // raw is null, and the branch it then takes is `raw.amount`.
  var raw = balance && balance.balance_amount;
  if (!raw) return null;

  var parsed = parseFloat(raw.amount);
  if (!isFinite(parsed)) return null;

  var magnitude = Math.abs(parsed);
  return balance.credit_debit_indicator === CREDIT_DEBIT.DEBIT ? -magnitude : magnitude;
}

/**
 * Choose one balance out of the several the API returns.
 *
 * Each bank supports only some of the types, so a single `balance` column
 * cannot be filled unconditionally — we take the first available in
 * BALANCE_PREFERENCE order and record which one it was, because "€1,240" means
 * different things as CLBD (booked, settled) and as ITAV (available, including
 * holds).
 *
 * A type outside the enum is used rather than discarded — a balance we can
 * read and label honestly beats no balance at all — and flagged, since it
 * means the enum has moved.
 */
function pickBalance(balances) {
  var usable = (balances || []).filter(function (b) { return balanceAmount(b) !== null; });
  if (!usable.length) return null;

  for (var i = 0; i < BALANCE_PREFERENCE.length; i++) {
    var match = usable.filter(function (b) { return b.balance_type === BALANCE_PREFERENCE[i]; })[0];
    if (match) return describeBalance_(match, false);
  }
  return describeBalance_(usable[0], true);
}

function describeBalance_(balance, unexpectedType) {
  var raw = balance.balance_amount || {};
  return {
    amount: balanceAmount(balance),
    currency: raw.currency || '',
    type: balance.balance_type || '',
    unexpectedType: unexpectedType,
    balance: balance
  };
}

/**
 * Write a fetched balance onto an account row.
 *
 * `balance_api` only — `balance` is an ARRAYFORMULA covering all three account
 * kinds, and no column in this project is ever written by both code and a
 * formula. `balances_raw` keeps the full typed set, because the interesting
 * question when a number looks wrong is always which of the several balances
 * the bank returned.
 */
function updateAccountBalance_(row, balances) {
  var sheet = sheetOrThrow_(TABS.ACCOUNTS);
  var picked = pickBalance(balances);
  var uid = readCell_(sheet, row, ACCOUNT_COLUMNS, 'account_id');

  if (!picked) {
    logAnomaly_(ANOMALY_KIND.MISSING_BALANCE, uid,
      'No readable balance in ' + ((balances || []).length) + ' returned.', balances);
    return null;
  }
  if (picked.unexpectedType) {
    logAnomaly_(ANOMALY_KIND.UNKNOWN_BALANCE_TYPE, uid,
      'Balance type "' + picked.type + '" is not in BALANCE_PREFERENCE; used it anyway.', balances);
  }

  writeCell_(sheet, row, ACCOUNT_COLUMNS, 'balance_api', picked.amount);
  writeCell_(sheet, row, ACCOUNT_COLUMNS, 'balance_type', picked.type);
  writeCell_(sheet, row, ACCOUNT_COLUMNS, 'balance_updated_at', new Date());
  writeCell_(sheet, row, ACCOUNT_COLUMNS, 'balances_raw', truncateForCell_(JSON.stringify(balances || [])));
  if (picked.currency) writeCell_(sheet, row, ACCOUNT_COLUMNS, 'currency', picked.currency);

  return picked;
}

function truncateForCell_(text) {
  return text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) + '…[truncated]' : text;
}

// ---------------------------------------------------------------------------
// The _status tab
// ---------------------------------------------------------------------------

/**
 * Shape a session into a _status row.
 *
 * Only the columns code owns — `state` and `days_left` are formulas, so they
 * are left alone here and stay truthful between syncs.
 */
/**
 * The durable identity of a bank link.
 *
 * `session_id` is the API handle, and it is replaced every time you redo SCA.
 * Keying `_status` on it meant a reconnect could not find the row it was
 * meant to update, so it wrote a second one — leaving behind a row with a
 * dead session and a `valid_until` in the past, which is precisely what the
 * consent-expiry detector looks for. It would then have alerted every day,
 * forever, about a bank that was working perfectly.
 *
 * Two rules, in this order:
 *
 * 1. **An overlap wins.** If any account this session exposes is already
 *    filed under a connection, that is the same connection reauthorised, and
 *    it keeps its id — including an id from before this rule existed, which
 *    is what stops an existing sheet needing a migration.
 * 2. **Otherwise derive from the bank**, and take the next free suffix if
 *    that name is taken. Deriving alone would be wrong: two separate logins
 *    at one bank produce the same name, and the second would silently
 *    inherit the first's row and overwrite its session. No account in
 *    common means a different connection, whatever it is called.
 */
function resolveConnectionId_(session, provider, accounts) {
  var covered = {};
  readRecords_(sheetOrThrow_(TABS.ACCOUNTS), ACCOUNT_COLUMNS).forEach(function (row) {
    if (!row.account_id || !row.connection_id) return;
    var id = String(row.connection_id);
    covered[id] = covered[id] || {};

    // Every identifier the row carries, because the incoming session knows
    // the account by whichever of them is current. The uid is not it: that
    // is precisely what a new consent changes.
    [row.account_id, row.identity_hash, row.provider_account_id].forEach(function (value) {
      if (value) covered[id][String(value)] = true;
    });
  });

  var wanted = [];
  (accounts || []).forEach(function (account) {
    if (account && account.uid) wanted.push(String(account.uid));
    if (account && account.identityHash) wanted.push(String(account.identityHash));
  });
  var reuse = '';
  Object.keys(covered).forEach(function (id) {
    if (reuse) return;
    var hit = wanted.some(function (uid) { return covered[id][uid]; });
    if (hit) reuse = id;
  });
  if (reuse) return reuse;

  var aspsp = (session && session.aspsp) || {};
  var base = connectionSlug_(aspsp.name) || connectionSlug_(provider);
  if (!base) return '';

  var country = connectionSlug_(aspsp.country);
  if (country) base += '-' + country;

  var taken = {};
  readColumn_(sheetOrThrow_(TABS.STATUS), colIndex_(STATUS_COLUMNS, 'connection_id'))
    .forEach(function (id) { if (id) taken[String(id)] = true; });

  if (!taken[base]) return base;
  for (var n = 2; n <= MAX_PLAUSIBLE_ACCOUNTS; n++) {
    if (!taken[base + '-' + n]) return base + '-' + n;
  }
  return base;
}

/** A bank name as a key: lowercase, no punctuation, no leading or trailing dash. */
function connectionSlug_(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function mapSessionToStatusRow(session, provider, now, fallbackSessionId, connectionId) {
  var validUntil = (session.access && session.access.valid_until) || session.valid_until || '';
  var id = sessionId(session) || fallbackSessionId || '';
  return {
    connection_id: connectionId || id,
    provider: provider,
    session_id: id,
    valid_until: validUntil ? new Date(validUntil) : '',
    last_success: now,
    last_error: '',
    accounts_covered: extractAccounts(session).length
  };
}

function upsertStatusRow_(row) {
  var sheet = sheetOrThrow_(TABS.STATUS);
  var idColumn = colIndex_(STATUS_COLUMNS, 'connection_id');

  // An upsert with no key is not an upsert. `findRowByValue_` matches nothing
  // on a blank, so this would append a fresh unkeyed row every single run
  // while looking exactly like a successful update. Fail loudly instead.
  if (!row.connection_id) {
    throw new Error('Refusing to write a _status row with no connection_id: ' +
      'the session response carried no id and no fallback was passed.');
  }

  var existing = findRowByValue_(sheet, idColumn, row.connection_id);
  var target = existing || nextEmptyRow_(sheet, idColumn);

  writeCell_(sheet, target, STATUS_COLUMNS, 'connection_id', row.connection_id);
  writeCell_(sheet, target, STATUS_COLUMNS, 'provider', row.provider);
  writeCell_(sheet, target, STATUS_COLUMNS, 'session_id', row.session_id);
  writeCell_(sheet, target, STATUS_COLUMNS, 'valid_until', row.valid_until);
  writeCell_(sheet, target, STATUS_COLUMNS, 'last_success', row.last_success);
  writeCell_(sheet, target, STATUS_COLUMNS, 'last_error', row.last_error);
  writeCell_(sheet, target, STATUS_COLUMNS, 'accounts_covered', row.accounts_covered);
}

/**
 * Record how a connection fared on this run.
 *
 * `last_error` is what the `state` formula reads to decide a connection is in
 * trouble, and clearing it on success is as important as setting it on
 * failure: a stale error would leave a working connection reading ERROR
 * forever, which is how an alarm becomes background noise.
 */
function recordConnectionOutcome_(connectionId, error, when) {
  if (!connectionId) return;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.STATUS);
  if (!sheet) return;

  var row = findRowByValue_(sheet, colIndex_(STATUS_COLUMNS, 'connection_id'), connectionId);
  if (!row) return;

  writeCell_(sheet, row, STATUS_COLUMNS, 'last_error', error ? String(error).slice(0, 500) : '');
  if (!error) writeCell_(sheet, row, STATUS_COLUMNS, 'last_success', when || new Date());
}
