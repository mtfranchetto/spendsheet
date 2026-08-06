/**
 * The door and the lock.
 *
 * One project serves two URLs with different access settings, and both of them
 * run the same `doGet`. That makes two things worth testing hard, and neither
 * of them is a happy path:
 *
 *   **The route.** A bank's callback and a person opening the app are told
 *   apart by the query string alone. Serving the app to a callback loses the
 *   authorisation code, which expires; refusing a callback because it looked
 *   like a person is the same failure from the other side.
 *
 *   **The gate.** The app URL is anonymous by necessity — the bank's redirect
 *   carries no Google session — so every way of not knowing who is asking has
 *   to be a refusal. The cases below are that list, and the reason each one is
 *   written out rather than folded into "invalid input" is that they arrive
 *   from different places: `''` from an anonymous visitor, a throw from the
 *   runtime, a blank owner from a book nobody has run `setup()` on.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

const ctx = load();

describe('which page a request wants', () => {
  it('sends a completed callback to the consent flow', () => {
    expect(ctx.webAppRoute_({ code: 'auth-code', state: 'nonce' })).toBe('consent');
  });

  it('sends a refused callback there too, so the message reaches you', () => {
    // A bank that denies consent comes back with `state` and `error` and no
    // `code`. That page has to be the consent page or nothing ever says why.
    expect(ctx.webAppRoute_({ state: 'nonce', error: 'access_denied' })).toBe('consent');
  });

  it('treats either parameter alone as a callback', () => {
    expect(ctx.webAppRoute_({ code: 'auth-code' })).toBe('consent');
    expect(ctx.webAppRoute_({ state: 'nonce' })).toBe('consent');
  });

  it('does not let a bare error parameter reach the consent branch', () => {
    // `error` is the one parameter anyone can put on the URL. Treating it as a
    // consent signal would hand a stranger that branch of doGet.
    expect(ctx.webAppRoute_({ error: '<script>' })).toBe('app');
  });

  it('sends a request with nothing on it to the app', () => {
    expect(ctx.webAppRoute_({})).toBe('app');
    expect(ctx.webAppRoute_(undefined)).toBe('app');
  });
});

describe('the owner gate', () => {
  const decide = (owner, active) => ctx.webAppAccessDecision_(owner, active);

  it('lets the owner through', () => {
    expect(decide('you@example.com', 'you@example.com').ok).toBe(true);
  });

  it('ignores case and surrounding space, which Google is inconsistent about', () => {
    expect(decide('You@Example.com', ' you@example.com ').ok).toBe(true);
  });

  it('refuses an anonymous visitor', () => {
    // This is what Door 1 produces: getEmail() returns '' with no session.
    expect(decide('you@example.com', '').ok).toBe(false);
  });

  it('refuses when the address is missing rather than empty', () => {
    // String(undefined) is 'undefined', and two of those compare equal — which
    // is why the type test comes before the comparison.
    expect(decide('you@example.com', undefined).ok).toBe(false);
    expect(decide('you@example.com', null).ok).toBe(false);
    expect(decide(undefined, undefined).ok).toBe(false);
  });

  it('refuses a different account', () => {
    expect(decide('you@example.com', 'someone@else.com').ok).toBe(false);
  });

  it('refuses everyone when no owner is configured', () => {
    // An unconfigured lock has to be a closed one. The alternative is a book
    // that serves its balances to anyone until someone remembers to run setup.
    expect(decide('', 'you@example.com').ok).toBe(false);
    expect(decide('   ', 'you@example.com').ok).toBe(false);
  });

  it('refuses when the runtime throws instead of answering', () => {
    // A throw is not "probably fine". activeUserEmail_ turns it into '', which
    // the decision above already refuses.
    const c = load();
    c.Session.getActiveUser = () => { throw new Error('no user for this deployment'); };
    expect(c.activeUserEmail_()).toBe('');
  });
});

describe('the owner address', () => {
  it('is seeded from the account that ran setup', () => {
    const c = load({ userEmail: 'owner@example.com' });
    c.setup();

    const config = c.__spreadsheet.getSheetByName('_config');
    const row = c.findRowByValue_(config, 1, 'owner_email');
    expect(c.readCell_(config, row, c.CONFIG_COLUMNS, 'value')).toBe('owner@example.com');
    expect(c.webAppOwner_()).toBe('owner@example.com');
  });

  it('is not moved by a second account running setup on a shared book', () => {
    const c = load({ userEmail: 'owner@example.com' });
    c.setup();

    c.Session.getEffectiveUser = () => ({ getEmail: () => 'guest@example.com' });
    c.setup();

    expect(c.webAppOwner_()).toBe('owner@example.com');
  });

  it('leaves the lock closed when the runtime will not name the account', () => {
    const c = load();
    c.Session.getEffectiveUser = () => { throw new Error('no effective user'); };
    c.setup();

    expect(c.webAppOwner_()).toBe('');
    expect(c.webAppAccessDecision_(c.webAppOwner_(), 'anyone@example.com').ok).toBe(false);
  });

  it('ships blank in the seed, since 00_config touches no services', () => {
    const seeded = ctx.DEFAULT_CONFIG.filter((row) => row[0] === 'owner_email');
    expect(seeded).toHaveLength(1);
    expect(seeded[0][1]).toBe('');
  });
});

describe('doGet', () => {
  function book(options) {
    const c = load(options);
    c.setup();
    return c;
  }

  it('refuses the app to a caller it cannot identify', () => {
    const c = book({ userEmail: 'owner@example.com' });
    c.Session.getActiveUser = () => ({ getEmail: () => '' });

    const html = c.doGet({ parameter: {} }).getContent();
    expect(html).toContain('Not available');
  });

  it('says nothing about why, since the URL is public', () => {
    // A message distinguishing "wrong account" from "no owner configured"
    // would be a probing oracle, for no benefit to the one person who gets in.
    const wrongAccount = book({ userEmail: 'owner@example.com' });
    wrongAccount.Session.getActiveUser = () => ({ getEmail: () => 'someone@else.com' });

    const noOwner = load();
    noOwner.Session.getEffectiveUser = () => { throw new Error('no effective user'); };
    noOwner.setup();

    expect(wrongAccount.doGet({ parameter: {} }).getContent())
      .toBe(noOwner.doGet({ parameter: {} }).getContent());
  });

  it('leaves the consent path alone', () => {
    // The delegation is one line at the top and everything below it still
    // assumes a callback. A request carrying a state nonce is one.
    const c = book({ userEmail: 'owner@example.com' });
    const html = c.doGet({ parameter: { state: 'unknown-nonce', code: 'x' } }).getContent();

    expect(html).toContain('Not connected');
    expect(html).toContain('no longer valid');
  });

  it('reports a bank error rather than serving the app', () => {
    const c = book({ userEmail: 'owner@example.com' });
    c.PropertiesService.getScriptProperties().setProperty('EB_AUTH_STATE', JSON.stringify({
      state: 'good-nonce', aspspName: 'Mock ASPSP', country: 'FI', createdAt: Date.now()
    }));

    const html = c.doGet({ parameter: { state: 'good-nonce', error: 'access_denied' } })
      .getContent();
    expect(html).toContain('access_denied');
  });
});

describe('the deployment diagnostic', () => {
  it('reports both users, the owner, and whether this door would let you in', () => {
    // The gate turns entirely on what getActiveUser() returns on a *particular
    // deployment*, and the documentation on that is claims about deployments
    // rather than about code. So it is measured from both URLs, not assumed.
    const c = load({ userEmail: 'owner@example.com' });
    c.setup();

    const report = c.describeWebAppContext();
    expect(report).toMatchObject({
      activeUser: 'owner@example.com',
      effectiveUser: 'owner@example.com',
      owner: 'owner@example.com',
      allowed: true
    });
  });

  it('says a door is closed when the caller is anonymous', () => {
    const c = load({ userEmail: 'owner@example.com' });
    c.setup();
    c.Session.getActiveUser = () => ({ getEmail: () => '' });

    expect(c.describeWebAppContext()).toMatchObject({ activeUser: '(blank)', allowed: false });
  });

  it('records a throw as the finding rather than propagating it', () => {
    const c = load({ userEmail: 'owner@example.com' });
    c.setup();
    c.Session.getActiveUser = () => { throw new Error('boom'); };

    const report = c.describeWebAppContext();
    expect(report.activeUser).toContain('threw');
    expect(report.allowed).toBe(false);
  });
});
