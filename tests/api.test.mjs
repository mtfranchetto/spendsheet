/**
 * Enable Banking client — request construction and error mapping.
 *
 * Network and OAuth are stubbed, so this is deliberately thin coverage: it
 * proves we build the right request and interpret the answer correctly, not
 * that the API behaves as documented. Phase 3's live calls settle that.
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

/** A context with credentials installed and a scripted API. */
function withApi(handler, env = 'SANDBOX') {
  const properties = { EB_ENV: env };
  if (env === 'SANDBOX') {
    properties.EB_SANDBOX_APP_ID = 'sandbox-app';
    properties.EB_SANDBOX_KEY = privateKey;
  } else {
    properties.EB_PROD_APP_ID = 'prod-app';
    properties.EB_PROD_KEY = privateKey;
  }
  return load({ properties, fetch: handler });
}

const ok = (body) => () => ({ code: 200, body: JSON.stringify(body) });

describe('buildQuery', () => {
  it('drops empty values instead of sending them as ""', () => {
    expect(ctx.buildQuery({ a: 1, b: null, c: undefined, d: '', e: 'x' })).toBe('?a=1&e=x');
  });

  it('returns nothing when there is nothing to send', () => {
    expect(ctx.buildQuery(null)).toBe('');
    expect(ctx.buildQuery({})).toBe('');
    expect(ctx.buildQuery({ a: null })).toBe('');
  });

  it('encodes values', () => {
    expect(ctx.buildQuery({ country: 'IT', name: 'Mock ASPSP' })).toBe('?country=IT&name=Mock%20ASPSP');
  });
});

describe('buildRequestParams', () => {
  it('sends the token as a bearer and never throws on HTTP errors', () => {
    const params = ctx.buildRequestParams('GET', 'tok');
    expect(params.method).toBe('get');
    expect(params.headers.Authorization).toBe('Bearer tok');
    // Without this, a 429 raises before we can classify it.
    expect(params.muteHttpExceptions).toBe(true);
  });

  it('omits a body and content type on a GET', () => {
    const params = ctx.buildRequestParams('GET', 'tok');
    expect(params.payload).toBeUndefined();
    expect(params.contentType).toBeUndefined();
  });

  it('serialises a payload as JSON', () => {
    const params = ctx.buildRequestParams('POST', 'tok', { code: 'abc' });
    expect(params.contentType).toBe('application/json');
    expect(JSON.parse(params.payload)).toEqual({ code: 'abc' });
  });
});

describe('classifyEbError', () => {
  it('maps status codes when the body says nothing useful', () => {
    expect(ctx.classifyEbError(401, '')).toBe('AUTH_FAILED');
    expect(ctx.classifyEbError(403, '')).toBe('FORBIDDEN');
    expect(ctx.classifyEbError(404, '')).toBe('NOT_FOUND');
    expect(ctx.classifyEbError(422, '')).toBe('INVALID_REQUEST');
    expect(ctx.classifyEbError(429, '')).toBe('ASPSP_RATE_LIMIT_EXCEEDED');
    expect(ctx.classifyEbError(500, '')).toBe('PROVIDER_ERROR');
    expect(ctx.classifyEbError(503, '')).toBe('PROVIDER_ERROR');
    expect(ctx.classifyEbError(418, '')).toBe('UNKNOWN');
  });

  it('prefers the API error code, which distinguishes what status cannot', () => {
    // An expired consent and a malformed request both arrive as 4xx, but
    // only one of them means "the user has to re-authorise".
    expect(ctx.classifyEbError(400, JSON.stringify({ code: 'EXPIRED_SESSION' }))).toBe('EXPIRED_SESSION');
    expect(ctx.classifyEbError(400, JSON.stringify({ code: 'SESSION_EXPIRED' }))).toBe('EXPIRED_SESSION');
    expect(ctx.classifyEbError(400, JSON.stringify({ error: 'session has expired' }))).toBe('EXPIRED_SESSION');
  });

  it('recognises a rate limit however it is spelled', () => {
    expect(ctx.classifyEbError(400, JSON.stringify({ code: 'ASPSP_RATE_LIMIT_EXCEEDED' })))
      .toBe('ASPSP_RATE_LIMIT_EXCEEDED');
    expect(ctx.classifyEbError(400, JSON.stringify({ code: 'TOO-MANY-REQUESTS' })))
      .toBe('ASPSP_RATE_LIMIT_EXCEEDED');
  });

  it('falls back to the status when the body is not JSON', () => {
    expect(ctx.classifyEbError(500, '<html>gateway timeout</html>')).toBe('PROVIDER_ERROR');
  });
});

describe('error objects', () => {
  it('marks server errors retryable but never the rate limit', () => {
    // A 429 carries a multi-hour penalty; retrying in-loop burns the window
    // and achieves nothing, so it waits for the next scheduled run.
    expect(ctx.ebError('PROVIDER_ERROR', 'x').retryable).toBe(true);
    expect(ctx.ebError('ASPSP_RATE_LIMIT_EXCEEDED', 'x').retryable).toBe(false);
    expect(ctx.ebError('EXPIRED_SESSION', 'x').retryable).toBe(false);
  });

  it('keeps the raw body for _anomalies', () => {
    const e = ctx.ebError('UNKNOWN', 'x', 500, '{"weird":true}');
    expect(e.status).toBe(500);
    expect(e.body).toBe('{"weird":true}');
  });

  it('explains every code it can raise', () => {
    for (const code of Object.values(ctx.EB_ERROR)) {
      expect(ctx.describeEbError(code)).not.toBe('Unrecognised error.');
    }
  });
});

describe('credentials', () => {
  it('defaults to sandbox rather than production', () => {
    expect(load().ebEnvironment()).toBe('SANDBOX');
  });

  it('selects the key pair matching EB_ENV', () => {
    const sandbox = withApi(ok({}), 'SANDBOX');
    sandbox.ebGetApplication();
    expect(sandbox.decodeJwtPayload(sandbox.__fetches[0].params.headers.Authorization.slice(7)));

    const prod = withApi(ok({}), 'PRODUCTION');
    prod.ebGetApplication();

    // kid is the application ID, and kid is what picks the environment.
    const kidOf = (c) => JSON.parse(
      Buffer.from(c.__fetches[0].params.headers.Authorization.slice(7).split('.')[0], 'base64url').toString()
    ).kid;

    expect(kidOf(sandbox)).toBe('sandbox-app');
    expect(kidOf(prod)).toBe('prod-app');
  });

  it('fails with a usable message when nothing is installed', () => {
    expect(() => load().ebGetApplication()).toThrow(/installCredentials/);
  });
});

describe('validatePrivateKey', () => {
  it('accepts a real PEM', () => {
    expect(ctx.validatePrivateKey(privateKey)).toBeNull();
  });

  it('catches the mistakes people actually make', () => {
    expect(ctx.validatePrivateKey('')).toMatch(/Paste the contents/);
    expect(ctx.validatePrivateKey('   ')).toMatch(/Paste the contents/);
    expect(ctx.validatePrivateKey('abc123')).toMatch(/-----BEGIN/);
    expect(ctx.validatePrivateKey('-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----'))
      .toMatch(/public key/);
    expect(ctx.validatePrivateKey('-----BEGIN PRIVATE KEY-----\nMIIE'))
      .toMatch(/truncated/);
  });
});

describe('saveCredentials', () => {
  it('stores under the prefix for the chosen environment and leaves the other alone', () => {
    const c = load({ properties: { EB_SANDBOX_APP_ID: 'keep-me', EB_SANDBOX_KEY: privateKey } });
    c.saveCredentials('PRODUCTION', 'prod-1', privateKey);

    expect(c.__properties.get('EB_ENV')).toBe('PRODUCTION');
    expect(c.__properties.get('EB_PROD_APP_ID')).toBe('prod-1');
    expect(c.__properties.get('EB_SANDBOX_APP_ID')).toBe('keep-me');
  });

  it('rejects bad input before it reaches Script Properties', () => {
    const c = load();
    expect(() => c.saveCredentials('SANDBOX', '', privateKey)).toThrow();
    expect(() => c.saveCredentials('SANDBOX', 'id', 'not a key')).toThrow();
    expect(() => c.saveCredentials('STAGING', 'id', privateKey)).toThrow(/SANDBOX or PRODUCTION/);
    expect(c.__properties.size).toBe(0);
  });
});

describe('endpoints', () => {
  it('lists banks, filtered by country', () => {
    const c = withApi(ok({ aspsps: [{ name: 'Mock ASPSP', country: 'FI' }] }));
    const banks = c.ebListAspsps('IT');

    expect(banks).toHaveLength(1);
    expect(c.__fetches[0].url).toBe('https://api.enablebanking.com/aspsps?country=IT');
  });

  it('returns an empty list rather than undefined when there are no banks', () => {
    expect(withApi(ok({})).ebListAspsps()).toEqual([]);
  });

  it('escapes path parameters', () => {
    const c = withApi(ok({ balances: [] }));
    c.ebGetAccountBalances('acc/../secret');
    expect(c.__fetches[0].url).toContain('acc%2F..%2Fsecret');
  });

  it('passes the backfill strategy through', () => {
    // Full history is reachable only for ~1h after authorisation; missing
    // this on the first run costs a re-consent.
    const c = withApi(ok({ transactions: [] }));
    c.ebGetTransactionsPage('acc-1', { strategy: 'longest', dateFrom: '2024-01-01' });

    expect(c.__fetches[0].url).toContain('date_from=2024-01-01');
    expect(c.__fetches[0].url).toContain('strategy=longest');
  });

  it('raises a typed error the caller can switch on', () => {
    const c = withApi(() => ({ code: 429, body: JSON.stringify({ code: 'ASPSP_RATE_LIMIT_EXCEEDED' }) }));
    try {
      c.ebListAspsps();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ASPSP_RATE_LIMIT_EXCEEDED');
      expect(e.retryable).toBe(false);
      expect(e.status).toBe(429);
    }
  });
});

describe('ebGetAllTransactions', () => {
  it('follows continuation keys and concatenates pages', () => {
    let call = 0;
    const c = withApi(() => {
      call++;
      return call < 3
        ? { code: 200, body: JSON.stringify({ transactions: [{ n: call }], continuation_key: `k${call}` }) }
        : { code: 200, body: JSON.stringify({ transactions: [{ n: call }] }) };
    });

    const result = c.ebGetAllTransactions('acc-1');

    expect(result.transactions).toHaveLength(3);
    expect(result.pages).toBe(3);
    expect(result.truncated).toBe(false);
    expect(c.__fetches[1].url).toContain('continuation_key=k1');
  });

  it('reports truncation instead of pretending it fetched everything', () => {
    // A silent cap reads as complete data, which is exactly the kind of
    // quiet wrongness this project is built to avoid.
    const c = withApi(() => ({
      code: 200,
      body: JSON.stringify({ transactions: [{}], continuation_key: 'always-more' })
    }));

    const result = c.ebGetAllTransactions('acc-1', { maxPages: 3 });

    expect(result.pages).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.continuationKey).toBe('always-more');
  });

  it('handles an account with no transactions', () => {
    const result = withApi(ok({ transactions: [] })).ebGetAllTransactions('acc-1');
    expect(result.transactions).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
