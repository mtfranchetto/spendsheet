/**
 * The nightly run.
 *
 * These are the tests that answer the questions you would otherwise only
 * find out the answer to months later: does running twice insert duplicates,
 * does one bank being down stop the others, and does a pending charge that
 * settles end up in history exactly once.
 *
 * Everything is driven through a scripted API rather than by calling the
 * internals, because the interesting failures are in how the pieces meet.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { load } from './harness.mjs';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const CREDS = { EB_ENV: 'SANDBOX', EB_SANDBOX_APP_ID: 'app', EB_SANDBOX_KEY: privateKey };

/** The call budget only applies against a real bank — see accountCallAllowance_. */
const PROD_CREDS = { EB_ENV: 'PRODUCTION', EB_PROD_APP_ID: 'app', EB_PROD_KEY: privateKey };

/** A booked card payment, shaped as the aggregation API returns one. */
function booked(over) {
  return Object.assign({
    entry_reference: 'REF-1',
    transaction_amount: { currency: 'EUR', amount: '12.34' },
    credit_debit_indicator: 'DBIT',
    status: 'BOOK',
    booking_date: '2026-07-28',
    value_date: '2026-07-28',
    remittance_information: ['ESSELUNGA SPA TORINO'],
    creditor: { name: 'ESSELUNGA SPA' },
    merchant_category_code: '5411'
  }, over || {});
}

function pendingTx(over) {
  return booked(Object.assign({ status: 'PDNG', entry_reference: '' }, over || {}));
}

const CLOSING = {
  balance_amount: { currency: 'EUR', amount: '1240.55' },
  balance_type: 'CLBD',
  credit_debit_indicator: 'CRDT'
};

/**
 * A bank. `bank.booked` and `bank.pending` are read at call time, so a test
 * can change what the provider returns between two syncs — which is the only
 * way to model a charge settling.
 */
function bank(config) {
  const state = Object.assign({
    booked: [], pending: [], balances: [CLOSING], fail: null, calls: []
  }, config || {});

  state.fetch = (url) => {
    state.calls.push(url);
    if (state.fail) return state.fail;

    if (url.includes('/balances')) {
      return { code: 200, body: JSON.stringify({ balances: state.balances }) };
    }
    if (url.includes('/transactions')) {
      const wanted = /transaction_status=([A-Z]+)/.exec(url);
      const list = wanted && wanted[1] === 'PDNG' ? state.pending : state.booked;
      return { code: 200, body: JSON.stringify({ transactions: list }) };
    }
    return { code: 200, body: '{}' };
  };
  return state;
}

/** A built sheet with one active bank account and a scripted provider. */
function withAccounts(provider, uids = ['acc-1'], creds = CREDS) {
  const c = load({ properties: { ...creds }, fetch: provider.fetch });
  c.setup();

  const accounts = c.__spreadsheet.getSheetByName('accounts');
  const status = c.__spreadsheet.getSheetByName('_status');

  uids.forEach((uid, i) => {
    const row = i + 2;
    accounts.getRange(`A${row}`).setValue(uid);
    accounts.getRange(`B${row}`).setValue(`Account ${uid}`);
    accounts.getRange(`C${row}`).setValue('bank');
    accounts.getRange(`O${row}`).setValue(true);
    accounts.getRange(`P${row}`).setValue(`conn-${uid}`);

    status.getRange(`A${row}`).setValue(`conn-${uid}`);
    status.getRange(`C${row}`).setValue(`conn-${uid}`);
  });

  return c;
}

const tx = (c) => c.__spreadsheet.getSheetByName('transactions');
const uids = (c) => c.readColumn_(tx(c), 1).filter(Boolean);

function setConfig(c, key, value) {
  const config = c.__spreadsheet.getSheetByName('_config');
  config.getRange(c.readColumn_(config, 1).indexOf(key) + 2, 2).setValue(value);
}

describe('a first sync', () => {
  it('writes booked rows with money out as negative', () => {
    const provider = bank({ booked: [booked()] });
    const c = withAccounts(provider);

    const summary = c.syncNow();

    expect(summary.result).toBe('OK');
    expect(summary.inserted).toBe(1);
    expect(tx(c).getRange('B2').getValue()).toBe('acc-1');
    expect(tx(c).getRange('G2').getValue()).toBe(-12.34);
    expect(tx(c).getRange('I2').getValue()).toBe('ESSELUNGA SPA TORINO');
    expect(tx(c).getRange('N2').getValue()).toBe('enablebanking');
  });

  it('asks for the longest history it can get, once', () => {
    // Full history is reachable for about an hour after authorisation and
    // then drops to a rolling ~90 days. Missing it costs a re-consent.
    const provider = bank({ booked: [booked()] });
    const c = withAccounts(provider);

    c.syncNow();
    const first = provider.calls.filter((u) => u.includes('/transactions'));
    expect(first.every((u) => u.includes('strategy=longest'))).toBe(true);

    provider.calls.length = 0;
    c.syncNow();
    const second = provider.calls.filter((u) => u.includes('/transactions'));
    expect(second.some((u) => u.includes('strategy=longest'))).toBe(false);
    expect(second.every((u) => u.includes('date_from='))).toBe(true);
  });

  it('leaves the formula columns to the formulas', () => {
    const c = withAccounts(bank({ booked: [booked()] }));
    c.syncNow();

    // amount_eur is an ARRAYFORMULA anchored in P2. Writing 26 columns
    // instead of 15 would silently destroy it.
    expect(tx(c).getRange('P2').getFormula()).toContain('ARRAYFORMULA');
  });

  it('records the run, so a sync that fetched nothing is visible', () => {
    const c = withAccounts(bank({ booked: [booked()] }));
    c.syncNow();

    const runs = c.__spreadsheet.getSheetByName('_runs');
    expect(runs.getRange('D2').getValue()).toBe('manual');
    expect(runs.getRange('H2').getValue()).toBe(1);      // rows_inserted
    expect(runs.getRange('J2').getValue()).toBe('OK');
  });
});

describe('running again', () => {
  it('inserts nothing the second and third time', () => {
    const provider = bank({ booked: [booked(), booked({ entry_reference: 'REF-2' })] });
    const c = withAccounts(provider);

    expect(c.syncNow().inserted).toBe(2);
    expect(c.syncNow().inserted).toBe(0);
    expect(c.syncNow().inserted).toBe(0);
    expect(uids(c)).toHaveLength(2);
  });

  it('picks up only what is new', () => {
    const provider = bank({ booked: [booked()] });
    const c = withAccounts(provider);
    c.syncNow();

    provider.booked.push(booked({ entry_reference: 'REF-2', booking_date: '2026-07-29' }));
    expect(c.syncNow().inserted).toBe(1);
    expect(uids(c)).toHaveLength(2);
  });

  it('keeps both of two identical transactions with no reference', () => {
    const twin = () => booked({ entry_reference: '', transaction_amount: { currency: 'EUR', amount: '3.00' } });
    const provider = bank({ booked: [twin(), twin()] });
    const c = withAccounts(provider);

    expect(c.syncNow().inserted).toBe(2);
    expect(c.syncNow().inserted).toBe(0);   // and neither is re-inserted
    expect(uids(c)).toHaveLength(2);
  });

  it('never rewrites a row, so your notes stay attached to it', () => {
    const provider = bank({ booked: [booked()] });
    const c = withAccounts(provider);
    c.syncNow();
    tx(c).getRange('Y2').setValue('reimbursable');

    provider.booked[0].remittance_information = ['SOMETHING ELSE ENTIRELY'];
    c.syncNow();

    expect(tx(c).getRange('I2').getValue()).toBe('ESSELUNGA SPA TORINO');
    expect(tx(c).getRange('Y2').getValue()).toBe('reimbursable');
  });

  it('reports a reference that came back with a different amount', () => {
    const provider = bank({ booked: [booked()] });
    const c = withAccounts(provider);
    c.syncNow();

    provider.booked = [booked({ transaction_amount: { currency: 'EUR', amount: '99.00' } })];
    const summary = c.syncNow();

    expect(summary.inserted).toBe(0);
    const anomalies = c.__spreadsheet.getSheetByName('_anomalies');
    expect(c.readColumn_(anomalies, 3)).toContain('dup_entry_ref');
  });
});

describe('pending', () => {
  it('keeps pending out of history and in its own tab', () => {
    const provider = bank({ booked: [booked()], pending: [pendingTx()] });
    const c = withAccounts(provider);
    c.syncNow();

    const pending = c.__spreadsheet.getSheetByName('pending');
    expect(uids(c)).toHaveLength(1);
    expect(c.readColumn_(pending, 1).filter(Boolean)).toHaveLength(1);
    expect(pending.getRange('G2').getValue()).toBe(-12.34);
  });

  it('produces exactly one booked row and no orphan when a hold settles', () => {
    const provider = bank({ pending: [pendingTx({ transaction_amount: { currency: 'EUR', amount: '40.00' } })] });
    const c = withAccounts(provider);
    c.syncNow();

    // Settling: the bank stops listing it as pending and starts listing it
    // as booked, with its own entry_reference and possibly a new amount.
    provider.pending = [];
    provider.booked = [booked({
      entry_reference: 'REF-SETTLED',
      transaction_amount: { currency: 'EUR', amount: '41.50' }
    })];
    c.syncNow();

    expect(uids(c)).toHaveLength(1);
    expect(tx(c).getRange('G2').getValue()).toBe(-41.5);
    expect(c.readColumn_(c.__spreadsheet.getSheetByName('pending'), 1).filter(Boolean)).toEqual([]);
  });

  it('is rewritten, not accumulated', () => {
    const provider = bank({ pending: [pendingTx(), pendingTx({ booking_date: '2026-07-29' })] });
    const c = withAccounts(provider);
    // Two full syncs on one day is six calls, over the real daily cap — this
    // test is about the rewrite, so it buys the room rather than tripping it.
    setConfig(c, 'max_calls_per_account_per_day', 20);
    c.syncNow();

    provider.pending = [pendingTx()];
    c.syncNow();

    expect(c.readColumn_(c.__spreadsheet.getSheetByName('pending'), 1).filter(Boolean)).toHaveLength(1);
  });

  it('salvages pending rows from a provider that ignores the status filter', () => {
    // Free: they arrived in the booked response anyway. This is what makes
    // fetch_pending: no cost nothing on such a provider.
    const provider = bank({ booked: [booked(), pendingTx()] });
    const c = withAccounts(provider);
    setConfig(c, 'fetch_pending', 'no');

    c.syncNow();

    expect(uids(c)).toHaveLength(1);
    expect(c.readColumn_(c.__spreadsheet.getSheetByName('pending'), 1).filter(Boolean)).toHaveLength(1);
    expect(provider.calls.filter((u) => u.includes('PDNG'))).toHaveLength(0);
  });
});

describe('when a bank breaks', () => {
  it('finishes the other accounts and marks the run PARTIAL', () => {
    const provider = bank({ booked: [booked()] });
    const healthy = provider.fetch;
    provider.fetch = (url) => (url.includes('acc-2')
      ? { code: 500, body: '{"message":"upstream is down"}' }
      : healthy(url));

    const c = withAccounts(provider, ['acc-1', 'acc-2']);
    const summary = c.syncNow();

    expect(summary.result).toBe('PARTIAL');
    expect(summary.ok).toBe(1);
    expect(uids(c)).toHaveLength(1);
    expect(summary.message).toMatch(/Account acc-2/);
  });

  it('writes the failure to that connection, and clears it on recovery', () => {
    const provider = bank({ booked: [booked()] });
    provider.fail = { code: 500, body: '{"message":"upstream is down"}' };
    const c = withAccounts(provider);

    c.syncNow();
    const status = c.__spreadsheet.getSheetByName('_status');
    expect(String(status.getRange('H2').getValue())).not.toBe('');

    provider.fail = null;
    c.syncNow();

    // A stale error would leave a working connection reading ERROR forever.
    expect(status.getRange('H2').getValue()).toBe('');
  });

  it('does not retry a rate limit inside the run', () => {
    // The penalty is measured in hours. Retrying turns a delay into a lockout.
    const provider = bank({});
    provider.fail = { code: 429, body: '{"code":"ASPSP_RATE_LIMIT_EXCEEDED"}' };
    const c = withAccounts(provider);

    const summary = c.syncNow();

    expect(summary.result).toBe('FAIL');
    expect(provider.calls).toHaveLength(1);
    expect(c.readColumn_(c.__spreadsheet.getSheetByName('_anomalies'), 3)).toContain('rate_limited');
  });

  it('says a dead consent needs you, not another run', () => {
    // A rate limit clears itself; this never does. Reporting both as "last
    // sync failed" invites you to wait and see, which is the one response
    // that cannot work here.
    const provider = bank({});
    provider.fail = { code: 401, body: '{"error":"EXPIRED_SESSION","message":"Session is expired"}' };
    const c = withAccounts(provider);

    c.syncNow();

    const error = String(c.__spreadsheet.getSheetByName('_status').getRange('H2').getValue());
    expect(error).toMatch(/consent expired/);
    expect(error).toMatch(/Connect a bank/);
    expect(error).toMatch(/Nothing is lost/);
    expect(c.readColumn_(c.__spreadsheet.getSheetByName('_anomalies'), 3)).toContain('consent_died');
  });

  it('records how early the consent died, which is a fact about the bank', () => {
    // By the time you reconnect, valid_until has been overwritten — so if it
    // is not said now it cannot be said at all.
    const provider = bank({});
    const c = withAccounts(provider);
    const status = c.__spreadsheet.getSheetByName('_status');
    status.getRange('E2').setValue(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000));

    provider.fail = { code: 401, body: '{"error":"EXPIRED_SESSION"}' };
    c.syncNow();

    expect(String(status.getRange('H2').getValue())).toMatch(/died 90 days early/);
  });

  it('keeps the pending rows of an account it could not reach', () => {
    // Dropping them would make an outage look like the bank clearing your
    // holds.
    const provider = bank({ pending: [pendingTx()] });
    const c = withAccounts(provider);
    c.syncNow();
    expect(c.readColumn_(c.__spreadsheet.getSheetByName('pending'), 1).filter(Boolean)).toHaveLength(1);

    provider.fail = { code: 500, body: '{}' };
    c.syncNow();

    expect(c.readColumn_(c.__spreadsheet.getSheetByName('pending'), 1).filter(Boolean)).toHaveLength(1);
  });
});

describe('the daily call budget', () => {
  const prod = (provider) => withAccounts(provider, ['acc-1'], PROD_CREDS);

  it('does not apply in sandbox, where there is no bank to offend', () => {
    // Throttling the one environment you deliberately sync over and over in
    // is friction bought with no safety at all.
    const provider = bank({ booked: [booked()] });
    const c = withAccounts(provider);

    c.syncNow(); c.syncNow(); c.syncNow();

    expect(provider.calls.length).toBeGreaterThan(4);
  });

  it('spends what is left on transactions rather than on a balance', () => {
    // A full sync is three calls against a typical cap of four, so a second
    // one the same day has to choose. A balance missed today is simply
    // tomorrow's balance; a day of transactions falling out of the rolling
    // window is gone.
    const provider = bank({ booked: [booked()] });
    const c = prod(provider);

    c.syncNow();
    expect(provider.calls).toHaveLength(3);

    provider.calls.length = 0;
    c.syncNow();

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toContain('/transactions');
  });

  it('stops before the bank does, and does not call it a failure', () => {
    const provider = bank({ booked: [booked()] });
    const c = prod(provider);

    c.syncNow();
    c.syncNow();
    const used = provider.calls.length;

    const summary = c.syncNow();

    expect(provider.calls).toHaveLength(used);   // nothing further was sent
    expect(summary.message).toMatch(/daily calls already used/);
    // Nothing broke — we chose not to call. Marking it FAIL would train you
    // to ignore the alerts.
    expect(summary.result).toBe('OK');
  });

  it('starts again the next day', () => {
    const provider = bank({ booked: [booked()] });
    const c = prod(provider);
    c.syncNow();

    // The counter is keyed by date, so a stale one is not a smaller budget.
    c.__properties.set('SYNC_CALL_BUDGET', JSON.stringify({
      date: '2020-01-01', counts: { 'acc-1': 99 }
    }));

    provider.calls.length = 0;
    c.syncNow();
    expect(provider.calls).toHaveLength(3);
  });
});

describe('balances', () => {
  it('writes the preferred balance and says which one it was', () => {
    const provider = bank({
      balances: [
        { balance_amount: { currency: 'EUR', amount: '900.00' }, balance_type: 'ITAV' },
        CLOSING
      ]
    });
    const c = withAccounts(provider);
    c.syncNow();

    const accounts = c.__spreadsheet.getSheetByName('accounts');
    expect(accounts.getRange('H2').getValue()).toBe(1240.55);
    expect(accounts.getRange('K2').getValue()).toBe('CLBD');
  });

  it('reads an overdraft as negative', () => {
    // A Balance carries its own credit_debit_indicator. Ignoring it makes an
    // overdrawn account read positive and inflates net worth by twice the
    // overdraft.
    const provider = bank({
      balances: [{
        balance_amount: { currency: 'EUR', amount: '250.00' },
        balance_type: 'CLBD',
        credit_debit_indicator: 'DBIT'
      }]
    });
    const c = withAccounts(provider);
    c.syncNow();

    expect(c.__spreadsheet.getSheetByName('accounts').getRange('H2').getValue()).toBe(-250);
  });
});

describe('which accounts get synced', () => {
  it('skips cash and asset rows, and ones you have deactivated', () => {
    const provider = bank({ booked: [booked()] });
    const c = withAccounts(provider, ['acc-1', 'acc-2', 'acc-3']);
    const accounts = c.__spreadsheet.getSheetByName('accounts');
    accounts.getRange('C3').setValue('cash');
    accounts.getRange('O4').setValue(false);

    const summary = c.syncNow();

    expect(summary.attempted).toBe(1);
  });

  it('says what to do when there is nothing to sync', () => {
    const c = load({ properties: { ...CREDS }, fetch: bank({}).fetch });
    c.setup();

    const summary = c.syncNow();

    expect(summary.result).toBe('OK');
    expect(summary.message).toMatch(/Connect a bank/);
  });
});

describe('concurrency', () => {
  it('refuses a second run rather than letting two appends interleave', () => {
    // Both would read the same "already seen" set before either had written,
    // which is a duplicate no dedup can prevent.
    const c = load({ properties: { ...CREDS }, fetch: bank({}).fetch });
    c.setup();
    c.__setLockHeld(true);

    expect(() => c.syncAll({})).toThrow(/already running/);
  });
});
