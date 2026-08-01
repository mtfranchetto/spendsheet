/**
 * Sessions, accounts and balances — everything that happens after the browser
 * round-trip in 05_auth.gs has handed back a session.
 *
 * The fixtures here are recordings of live Mock ASPSP responses rather than
 * inventions. Three separate bugs got through because the shape we assumed
 * was not the shape that arrives, and a fixture written from the docs would
 * have reproduced all three faithfully.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { load } from './harness.mjs';

const ctx = load();

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const CREDS = { EB_ENV: 'SANDBOX', EB_SANDBOX_APP_ID: 'app', EB_SANDBOX_KEY: privateKey };

/**
 * The real shape, captured from a live Mock ASPSP session: `accounts` holds
 * UID strings and `accounts_data` holds the descriptions. This fixture is a
 * recording, not a guess — the previous guess had them merged, which read
 * zero accounts from a perfectly good session.
 */
const SESSION = {
  session_id: 'sess-42',
  status: 'AUTHORIZED',
  aspsp: { name: 'Mock ASPSP', country: 'IT' },
  psu_type: 'business',
  access: { accounts: null, balances: true, transactions: true, valid_until: '2027-01-26T19:55:29.069000Z' },
  accounts: ['acc-1', 'acc-2'],
  accounts_data: [
    { uid: 'acc-1', name: 'Current', currency: 'EUR', account_id: { iban: 'FI2112345600000785' } },
    { uid: 'acc-2', name: 'Savings', currency: 'EUR', account_id: { iban: 'FI2112345600000999' } }
  ]
};

/** Mock ASPSP itself returns no descriptive fields at all — only identifiers. */
const SPARSE_SESSION = {
  session_id: 'sess-43',
  status: 'AUTHORIZED',
  aspsp: { name: 'Mock ASPSP', country: 'IT' },
  access: { valid_until: '2027-01-26T19:55:29.069000Z' },
  accounts: ['a8160088-28a0-45f2-ba4d-3c7959863f92'],
  accounts_data: [{
    uid: 'a8160088-28a0-45f2-ba4d-3c7959863f92',
    identification_hash: 'WwpbCiJhc3BzcF9uYW1lIgpdLApb.BqpDfy',
    identification_hashes: ['WwpbCiJhc3BzcF9uYW1lIgpdLApb.BqpDfy']
  }]
};

/** A context with the sheet built, credentials installed and the API scripted. */
function connected(fetch) {
  const c = load({ properties: { ...CREDS }, fetch });
  c.setup();
  return c;
}
describe('extractAccounts', () => {
  it('joins the UID list to the separate details list', () => {
    expect(ctx.extractAccounts(SESSION)).toEqual([
      { uid: 'acc-1', name: 'Current', currency: 'EUR', iban: 'FI2112345600000785' },
      { uid: 'acc-2', name: 'Savings', currency: 'EUR', iban: 'FI2112345600000999' }
    ]);
  });

  it('still yields an account when the bank supplies no descriptive fields', () => {
    // Mock ASPSP returns only identifiers. An account with no name is still
    // an account, and dropping it is how this failed the first time.
    const accounts = ctx.extractAccounts(SPARSE_SESSION);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].uid).toBe('a8160088-28a0-45f2-ba4d-3c7959863f92');
    expect(accounts[0].name).toBe('');
  });

  it('reads UIDs with no accounts_data at all', () => {
    expect(ctx.extractAccounts({ accounts: ['acc-9'] }))
      .toEqual([{ uid: 'acc-9', name: '', currency: '', iban: '' }]);
  });

  it('reads accounts_data with no accounts list', () => {
    const accounts = ctx.extractAccounts({
      accounts_data: [{ uid: 'acc-7', product: 'Conto Corrente', currency: 'EUR' }]
    });
    expect(accounts).toEqual([{ uid: 'acc-7', name: 'Conto Corrente', currency: 'EUR', iban: '' }]);
  });

  it('tolerates objects in the accounts list, in case a bank differs', () => {
    expect(ctx.extractAccounts({ accounts: [{ uid: 'acc-3' }] })[0].uid).toBe('acc-3');
  });

  it('never lists the same account twice', () => {
    const accounts = ctx.extractAccounts({
      accounts: ['acc-1', 'acc-1'],
      accounts_data: [{ uid: 'acc-1', name: 'Current' }]
    });
    expect(accounts).toHaveLength(1);
  });

  it('handles a session with no accounts', () => {
    expect(ctx.extractAccounts({})).toEqual([]);
    expect(ctx.extractAccounts({ accounts: [] })).toEqual([]);
    expect(ctx.extractAccounts(null)).toEqual([]);
  });
});

describe('mergeAccountDetails', () => {
  const bare = { uid: 'acc-1', name: '', currency: '', iban: '' };

  it('fills in what the session did not carry', () => {
    expect(ctx.mergeAccountDetails(bare, {
      name: 'Fineco mock', currency: 'EUR', account_id: { iban: 'IT60X0542811101000000123456' }
    })).toEqual({
      uid: 'acc-1', name: 'Fineco mock', currency: 'EUR', iban: 'IT60X0542811101000000123456'
    });
  });

  it('never overwrites something the session already told us', () => {
    const known = { uid: 'acc-1', name: 'Current', currency: 'EUR', iban: 'FI21' };
    expect(ctx.mergeAccountDetails(known, { name: 'Other', currency: 'GBP' })).toEqual(known);
  });

  it('falls back through the fields a provider might use for a name', () => {
    expect(ctx.mergeAccountDetails(bare, { product: 'Conto Corrente' }).name).toBe('Conto Corrente');
    expect(ctx.mergeAccountDetails(bare, { display_name: 'Joint' }).name).toBe('Joint');
  });

  it('survives an absent or unhelpful response', () => {
    expect(ctx.mergeAccountDetails(bare, null)).toEqual(bare);
    expect(ctx.mergeAccountDetails(bare, {})).toEqual(bare);
  });
});

describe('enrichAccounts_', () => {
  it('names an account the session left bare', () => {
    const c = connected(() => ({ code: 200, body: JSON.stringify({ name: 'Fineco mock', currency: 'EUR' }) }));
    c.recordConnection(SPARSE_SESSION, 'Mock ASPSP');

    const accounts = c.__spreadsheet.getSheetByName('accounts');
    expect(accounts.getRange('B2').getValue()).toBe('Fineco mock');
    expect(accounts.getRange('F2').getValue()).toBe('EUR');
  });

  it('does not spend a call when the session already told us everything', () => {
    const c = connected(() => ({ code: 200, body: '{}' }));
    const before = c.__fetches.length;
    c.recordConnection({
      ...SESSION,
      accounts_data: [{ uid: 'acc-1', name: 'Current', currency: 'EUR', account_id: { iban: 'FI21' } }],
      accounts: ['acc-1']
    }, 'Mock ASPSP');

    expect(c.__fetches).toHaveLength(before);
  });

  it('keeps the connection when the provider has no details endpoint', () => {
    // A 404 here means "no name available", not "connection failed".
    const c = connected(() => ({ code: 404, body: '{}' }));
    c.recordConnection(SPARSE_SESSION, 'Mock ASPSP');

    const accounts = c.__spreadsheet.getSheetByName('accounts');
    expect(accounts.getRange('A2').getValue()).toBe('a8160088-28a0-45f2-ba4d-3c7959863f92');
    expect(accounts.getRange('B2').getValue()).toBe('Mock ASPSP account');
  });
});

describe('append position', () => {
  it('uses row 2 even though a formula already occupies it', () => {
    // accounts and _status both carry an ARRAYFORMULA in row 2, so
    // getLastRow() reports content with zero records. Appending after it
    // leaves a permanent blank first row.
    const c = connected(() => ({ code: 200, body: '{}' }));
    const accounts = c.__spreadsheet.getSheetByName('accounts');
    expect(accounts.getRange('J2').getFormula()).toContain('ARRAYFORMULA');

    c.recordConnection(SESSION, 'Mock ASPSP');

    expect(accounts.getRange('A2').getValue()).toBe('acc-1');
    expect(accounts.getRange('A3').getValue()).toBe('acc-2');
    expect(c.__spreadsheet.getSheetByName('_status').getRange('A2').getValue()).toBe('sess-42');
  });
});

describe('maskIban', () => {
  it('shows enough to recognise an account, not enough to use it', () => {
    expect(ctx.maskIban('IT60X0542811101000000123456')).toBe('IT60…3456');
    expect(ctx.maskIban('FI21 1234 5600 0007 85')).toBe('FI21…0785');
  });

  it('leaves short or absent values alone', () => {
    expect(ctx.maskIban('')).toBe('');
    expect(ctx.maskIban(null)).toBe('');
    expect(ctx.maskIban('12345678')).toBe('12345678');
  });
});

describe('recordConnection', () => {
  it('adds discovered accounts as bank accounts', () => {
    const c = connected(() => ({ code: 200, body: '{}' }));
    c.recordConnection(SESSION, 'Mock ASPSP');

    const accounts = c.__spreadsheet.getSheetByName('accounts');
    expect(accounts.getRange('A2').getValue()).toBe('acc-1');
    expect(accounts.getRange('C2').getValue()).toBe('bank');
    expect(accounts.getRange('E2').getValue()).toBe('FI21…0785');
    expect(accounts.getLastRow()).toBe(3);
  });

  it('replaces its own placeholder once the provider supplies a real name', () => {
    let named = false;
    const c = connected(() => named
      ? { code: 200, body: JSON.stringify({ name: 'Fineco mock' }) }
      : { code: 404, body: '{}' });

    c.recordConnection(SPARSE_SESSION, 'Mock ASPSP');
    const accounts = c.__spreadsheet.getSheetByName('accounts');
    expect(accounts.getRange('B2').getValue()).toBe('Mock ASPSP account');

    named = true;
    c.recordConnection(SPARSE_SESSION, 'Mock ASPSP');

    // The placeholder was never anyone's decision, so it is safe to replace.
    expect(accounts.getRange('B2').getValue()).toBe('Fineco mock');
  });

  it('takes the connection id from the caller when the response omits it', () => {
    // POST /sessions echoes the id it minted; GET /sessions/{id} does not,
    // having been given it in the path. A refresh reads the second shape.
    const c = connected(() => ({ code: 200, body: '{}' }));
    const noId = { ...SESSION };
    delete noId.session_id;

    c.recordConnection(noId, 'Mock ASPSP', 'sess-42');

    const status = c.__spreadsheet.getSheetByName('_status');
    expect(status.getRange('A2').getValue()).toBe('sess-42');
    expect(c.__spreadsheet.getSheetByName('accounts').getRange('P2').getValue()).toBe('sess-42');
  });

  it('updates the one status row rather than growing a new one each refresh', () => {
    // The bug this pins: an empty key matches nothing, so every refresh
    // appended a fresh unkeyed row while reporting success.
    const c = connected(() => ({ code: 200, body: '{}' }));
    const noId = { ...SESSION };
    delete noId.session_id;

    c.recordConnection(noId, 'Mock ASPSP', 'sess-42');
    c.recordConnection(noId, 'Mock ASPSP', 'sess-42');
    c.recordConnection(noId, 'Mock ASPSP', 'sess-42');

    const status = c.__spreadsheet.getSheetByName('_status');
    expect(status.getRange('A3').getValue()).toBe('');
  });

  it('refuses to write a status row with no key at all', () => {
    const c = connected(() => ({ code: 200, body: '{}' }));
    const noId = { ...SESSION };
    delete noId.session_id;

    expect(() => c.recordConnection(noId, 'Mock ASPSP')).toThrow(/connection_id/);
  });

  it('keeps a name you gave an account when the bank is reconnected', () => {
    const c = connected(() => ({ code: 200, body: '{}' }));
    c.recordConnection(SESSION, 'Mock ASPSP');

    const accounts = c.__spreadsheet.getSheetByName('accounts');
    accounts.getRange('B2').setValue('My spending account');

    c.recordConnection(SESSION, 'Mock ASPSP');

    expect(accounts.getRange('B2').getValue()).toBe('My spending account');
    expect(accounts.getLastRow()).toBe(3);   // no duplicates
  });

  it('updates the existing _status row rather than appending on reconnect', () => {
    const c = connected(() => ({ code: 200, body: '{}' }));
    c.recordConnection(SESSION, 'Mock ASPSP');
    c.recordConnection(SESSION, 'Mock ASPSP');

    expect(c.__spreadsheet.getSheetByName('_status').getLastRow()).toBe(2);
  });
});

describe('pickBalance', () => {
  const of = (type, amount, indicator) => ({
    balance_amount: { currency: 'EUR', amount: amount },
    balance_type: type,
    credit_debit_indicator: indicator
  });

  it('takes the first available in preference order', () => {
    // "€1,240" means different things as CLBD (booked and settled) and as
    // ITAV (available, net of holds), so which one was used is recorded.
    const picked = ctx.pickBalance([of('OTHR', '1'), of('ITAV', '900'), of('CLBD', '1240.55')]);
    expect(picked.type).toBe('CLBD');
    expect(picked.amount).toBe(1240.55);
  });

  it('reads an overdraft as negative', () => {
    // A Balance carries its own credit_debit_indicator, independently of the
    // one on a transaction. Ignoring it inflates net worth by twice the
    // overdraft.
    expect(ctx.pickBalance([of('CLBD', '250.00', 'DBIT')]).amount).toBe(-250);
  });

  it('does not double-negate an already-signed amount', () => {
    expect(ctx.pickBalance([of('CLBD', '-250.00', 'DBIT')]).amount).toBe(-250);
  });

  it('uses a type it does not recognise rather than reporting no balance', () => {
    const picked = ctx.pickBalance([of('NEWTYPE', '10')]);
    expect(picked.amount).toBe(10);
    expect(picked.type).toBe('NEWTYPE');
    expect(picked.unexpectedType).toBe(true);
  });

  it('reports nothing when nothing is readable', () => {
    expect(ctx.pickBalance([])).toBe(null);
    expect(ctx.pickBalance(null)).toBe(null);
    expect(ctx.pickBalance([{ balance_type: 'CLBD' }])).toBe(null);
  });

  it('survives junk in the list rather than taking the account down', () => {
    // A null entry used to throw here, which would have failed the whole
    // account's sync — from a function whose entire job is tolerating
    // whatever a provider sends.
    expect(ctx.pickBalance([null])).toBe(null);
    expect(ctx.pickBalance([undefined, of('CLBD', '10')]).amount).toBe(10);
    expect(ctx.pickBalance([{ balance_amount: null, balance_type: 'CLBD' }])).toBe(null);
  });

  it('reads a zero balance as a balance', () => {
    expect(ctx.pickBalance([of('CLBD', '0.00')]).amount).toBe(0);
  });

  it('skips a type whose amount will not parse', () => {
    const picked = ctx.pickBalance([of('CLBD', 'n/a'), of('ITBD', '5')]);
    expect(picked.type).toBe('ITBD');
  });
});

describe('listSyncableAccounts_', () => {
  function withRow(c, row, values) {
    Object.entries(values).forEach(([col, value]) =>
      c.__spreadsheet.getSheetByName('accounts').getRange(`${col}${row}`).setValue(value));
  }

  it('is bank accounts you have not deactivated, and nothing else', () => {
    const c = load();
    c.setup();
    withRow(c, 2, { A: 'acc-1', B: 'Fineco', C: 'bank', O: true, P: 'conn-1' });
    withRow(c, 3, { A: 'wallet', B: 'Cash', C: 'cash', O: true });
    withRow(c, 4, { A: 'acc-2', B: 'Closed', C: 'bank', O: false });

    const accounts = c.listSyncableAccounts_();

    expect(accounts.map((a) => a.uid)).toEqual(['acc-1']);
    expect(accounts[0].connectionId).toBe('conn-1');
    expect(accounts[0].row).toBe(2);
  });

  it('accepts a hand-typed yes in the active column', () => {
    const c = load();
    c.setup();
    withRow(c, 2, { A: 'acc-1', C: 'bank', O: 'yes' });
    expect(c.listSyncableAccounts_()).toHaveLength(1);
  });
});

describe('connection_id', () => {
  it('links an account back to the consent that covers it', () => {
    // Without it there is no way to attribute a fetch failure to the
    // connection whose _status row should carry the error.
    const c = connected(() => ({ code: 200, body: '{}' }));
    c.recordConnection(SESSION, 'Mock ASPSP');

    const accounts = c.__spreadsheet.getSheetByName('accounts');
    expect(accounts.getRange('P2').getValue()).toBe('sess-42');
    expect(c.listSyncableAccounts_()[0].connectionId).toBe('sess-42');
  });
});
