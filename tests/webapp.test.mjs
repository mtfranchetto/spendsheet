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

  /*
    Two people share a household ledger, so `owner_email` is a list. The
    alternative — one person using the other's Google account — is worse in
    every direction, including this one: it would make the audit trail on the
    sheet say one name for two pairs of hands.

    The refusals below matter more than the admissions. Door 2 can only be
    shared by opening it to "anyone with a Google account", at which point this
    comparison is the *entire* thing standing between the internet and a set of
    bank balances.
  */
  it('lets a second address through, and still refuses a third party', () => {
    const both = 'you@example.com, her@example.com';
    expect(decide(both, 'her@example.com').ok).toBe(true);
    expect(decide(both, 'you@example.com').ok).toBe(true);
    expect(decide(both, 'someone@else.com').ok).toBe(false);
  });

  it('ignores spacing and case in a list, the way it does for one', () => {
    expect(decide(' You@Example.com ,  HER@example.com ', 'her@example.com').ok).toBe(true);
  });

  it('does not let a trailing comma open the door to nobody', () => {
    // The failure this prevents: a stray comma yields an empty entry, and an
    // empty entry compares equal to the '' that `activeUserEmail_` returns when
    // Google declines to say who is calling — which is the exact case the gate
    // exists to refuse. "We do not know who this is" must never resolve to yes.
    expect(decide('you@example.com,', '').ok).toBe(false);
    expect(decide('you@example.com,,', undefined).ok).toBe(false);
    expect(decide(',', 'you@example.com').ok).toBe(false);
  });

  it('refuses a list of nothing but noise', () => {
    expect(decide('nobody, , not-an-address', 'you@example.com').ok).toBe(false);
  });

  it('refuses when the runtime throws instead of answering', () => {
    // A throw is not "probably fine". activeUserEmail_ turns it into '', which
    // the decision above already refuses.
    const c = load();
    c.Session.getActiveUser = () => { throw new Error('no user for this deployment'); };
    expect(c.activeUserEmail_()).toBe('');
  });
});

describe('the browser tab icon', () => {
  const withFavicon = (url) => {
    const c = load({ userEmail: 'owner@example.com' });
    c.setup();

    const config = c.__spreadsheet.getSheetByName('_config');
    const row = c.findRowByValue_(config, 1, 'favicon_url');
    if (url !== undefined) c.writeCell_(config, row, c.CONFIG_COLUMNS, 'value', url);
    return c;
  };

  it('sets the favicon when one is configured', () => {
    const c = withFavicon('https://example.com/icon.png');
    expect(c.webAppHtml_().faviconUrl).toBe('https://example.com/icon.png');
  });

  it('ships this project’s own icon as the default', () => {
    // It stopped being a question the moment there was an answer that works for
    // everybody, and a default is what carries it to a book already set up:
    // `setup()` only ever *adds* seed rows, so a blank cell on an existing book
    // is reached by "Update mappings to defaults" and nothing else.
    const seeded = ctx.DEFAULT_CONFIG.filter((row) => row[0] === 'favicon_url');
    expect(seeded).toHaveLength(1);
    expect(seeded[0][1]).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.+\.png$/);
    expect(withFavicon().webAppHtml_().faviconUrl).toBe(seeded[0][1]);
  });

  it('asks for nothing when the cell is cleared', () => {
    // Clearing it is how you turn the icon off, so it has to mean that rather
    // than falling back to the default. Passing '' would ask Google to fetch
    // the current page as an image.
    expect(withFavicon('').webAppHtml_().faviconUrl).toBeNull();
    expect(withFavicon('   ').webAppHtml_().faviconUrl).toBeNull();
  });

  it('refuses anything that is not an https URL', () => {
    // Google fetches this server-side. A `data:` URI is rejected outright, and
    // `javascript:` in a cell that ends up in a document is the shape of thing
    // this project checks by whitelist rather than by escaping.
    ['data:image/png;base64,iVBOR', 'javascript:alert(1)', 'http://example.com/i.png',
      '/relative.png'].forEach((bad) => {
      expect(withFavicon(bad).webAppHtml_().faviconUrl, bad).toBeNull();
    });
  });

  it('still serves the page when the icon is refused', () => {
    // The icon is decoration; the page is the thing. A bad cell must not be a
    // blank screen for the only person allowed to open it.
    const page = withFavicon('nonsense').webAppHtml_();
    expect(page.getTitle()).toBe('Spendsheet');
    expect(page.getContent()).toContain('id="boot"');
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

/**
 * What the URL says the app should be showing.
 *
 * The app is in a sandboxed iframe, so a refresh reloads the parent `/exec`
 * document and everything the page held is gone. The query string is the only
 * state that crosses that, which makes this the whole of "deep linking" — and
 * it is reached by an anonymous endpoint, so what it does with a stranger's
 * parameters is worth writing out rather than assuming.
 */
describe('the view on the URL', () => {
  const view = (parameters) => ctx.webAppView_(parameters);

  it('opens on the dashboard when the URL names nothing', () => {
    expect(view({}).screen).toBe('dashboard');
    expect(view(undefined).screen).toBe('dashboard');
    expect(view({}).filters).toEqual({});
  });

  it('opens on the screen the URL names', () => {
    expect(view({ v: ['records'] }).screen).toBe('records');
    expect(view({ v: ['analytics'] }).screen).toBe('analytics');
  });

  it('takes a screen name however it was typed', () => {
    expect(view({ v: ['  Records '] }).screen).toBe('records');
  });

  it('replaces an unknown screen rather than passing it on', () => {
    // The screen is interpolated into the served page. Replacing it with one of
    // our own constants is what makes that safe by construction rather than by
    // escaping — and `v` is a parameter anyone can put on this public URL.
    ['add', 'revalue', 'nonsense', '', '../etc'].forEach((asked) => {
      const screen = view({ v: [asked] }).screen;
      expect(ctx.WEBAPP_SCREENS.indexOf(screen), asked).not.toBe(-1);
    });
  });

  it('does not offer the two screens that need an account in hand', () => {
    // `add` and `revalue` are opened from an account tile and carry that
    // account in memory only. A URL naming one would restore a form that had
    // forgotten what it was for.
    expect(ctx.WEBAPP_SCREENS).toEqual(['dashboard', 'analytics', 'records']);
  });

  it('carries the filters the URL named, and only those', () => {
    // Absent rather than defaulted: a key that is not here means "whatever the
    // server's default is", so a bookmark cannot freeze today's default.
    expect(view({ v: ['records'], p: ['year:2024'] }).filters)
      .toEqual({ period: 'year:2024' });
  });

  it('keeps every account, because the filter is a set', () => {
    // Repeated parameters rather than one joined value: a separator is a bet
    // that no account is ever named with it in it, and losing an account off a
    // filter is a screen that quietly answers a different question.
    expect(view({ a: ['Cash', 'Revolut, Ltd'] }).filters.accounts)
      .toEqual(['Cash', 'Revolut, Ltd']);
  });

  it('reads a single value that did not arrive in an array', () => {
    // `e.parameters` gives arrays. Anything hand-built might not, and a bare
    // string treated as a list is a filter for each of its characters.
    expect(view({ a: 'Cash' }).filters.accounts).toEqual(['Cash']);
    expect(view({ v: 'records' }).screen).toBe('records');
  });

  it('drops a parameter that is present and empty', () => {
    // `?q=&l=` is what an emptied field would leave behind. It means "no
    // filter", not "match the empty string".
    expect(view({ q: [''], l: ['   '], a: ['', 'Cash'] }).filters)
      .toEqual({ accounts: ['Cash'] });
  });

  it('treats only `1` as the review filter being on', () => {
    // A parameter true by its presence alone makes `u=0` and `u=false` both
    // read as "yes" — a screen showing a fraction of the ledger, silently.
    expect(view({ u: ['1'] }).filters.unconfirmed).toBe(true);
    ['0', 'false', 'true', 'yes', ''].forEach((asked) => {
      expect(view({ u: [asked] }).filters.unconfirmed, asked).toBeUndefined();
    });
  });

  it('bounds what a stranger can put into the document', () => {
    const long = 'x'.repeat(ctx.WEBAPP_PARAM_MAX + 500);
    expect(view({ q: [long] }).filters.search).toHaveLength(ctx.WEBAPP_PARAM_MAX);

    const many = [];
    for (let i = 0; i < ctx.WEBAPP_ACCOUNTS_MAX + 20; i++) many.push('a' + i);
    expect(view({ a: many }).filters.accounts).toHaveLength(ctx.WEBAPP_ACCOUNTS_MAX);
  });

  it('passes a filter value through as typed, since escaping is the boundary', () => {
    // An account name is whatever the `accounts` tab says, so this cannot be a
    // whitelist the way the screen is. It is bounded here and escaped by
    // `htmlSafeJson_` on the way into the page — and the page may send any
    // filter it likes to `appRecords` already.
    expect(view({ l: ['Kids & Co'] }).filters.label).toBe('Kids & Co');
  });

  it('cannot move a request across the consent line', () => {
    // The route is decided by `code` and `state` alone, and none of the view
    // parameters is either — in both directions.
    expect(ctx.webAppRoute_({ v: 'records', p: 'mtd', a: 'Cash' })).toBe('app');
    expect(ctx.webAppRoute_({ v: 'records', code: 'auth-code' })).toBe('consent');
  });
});

describe('the view, in the page the server sends', () => {
  function book(options) {
    const c = load(options);
    c.setup();
    return c;
  }

  it('is written into the document, not fetched by the page', () => {
    // `google.script.url.getLocation` would read the same URL from inside the
    // iframe, asynchronously — so the page would draw the dashboard before
    // learning it was meant to be on Charts. A visible flip on every refresh.
    const html = book().webAppHtml_({ v: ['records'], p: ['year:2024'] }).getContent();

    expect(html).toContain('id="view"');
    expect(html).toContain('"screen":"records"');
    expect(html).toContain('"period":"year:2024"');
    expect(html).not.toContain('<?!=');
  });

  it('says dashboard when the URL named nothing, rather than nothing at all', () => {
    // The page falls back on an unreadable payload, but a template that prints
    // an empty element is the failure that looks like a working one.
    const html = book().webAppHtml_().getContent();
    expect(html).toContain('"screen":"dashboard"');
  });

  it('escapes a filter value that could close the element it sits in', () => {
    const c = book();
    const payload = c.htmlSafeJson_(c.webAppView_({ a: ['ACME </script> LTD'] }));

    expect(payload).toContain('ACME');
    expect(payload).not.toContain('<');
    expect(payload).toContain('\\u003c');
    expect(() => JSON.parse(payload)).not.toThrow();
    expect(c.webAppHtml_({ a: ['ACME </script> LTD'] }).getContent()).toContain('\\u003c');
  });

  it('survives the inline dashboard failing, since they are different features', () => {
    const c = book();
    c.appInlineBoot_ = undefined;

    const html = c.webAppHtml_({ v: ['analytics'] }).getContent();
    expect(html).toContain('"screen":"analytics"');
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

  it('hands the app the multi-valued parameters, not the flattened ones', () => {
    // `e.parameter` keeps only the first value of a repeated parameter, and the
    // account filter is a set — so serving the app from that map would silently
    // drop every account after the first off a bookmarked filter.
    const c = book({ userEmail: 'owner@example.com' });
    const html = c.doGet({
      parameter: { v: 'records', a: 'Cash' },
      parameters: { v: ['records'], a: ['Cash', 'Revolut'] }
    }).getContent();

    expect(html).toContain('"screen":"records"');
    expect(html).toContain('"Revolut"');
  });

  it('serves a page with a view on it even when there are no parameters', () => {
    const c = book({ userEmail: 'owner@example.com' });
    expect(c.doGet({ parameter: {} }).getContent()).toContain('"screen":"dashboard"');
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
