/**
 * JWT construction.
 *
 * The signature is verified against a real RSA key rather than snapshotted,
 * because the failure this guards against is subtle: if the bytes we sign
 * differ by even one character from the bytes we transmit, every request is
 * rejected with an error that says nothing about why.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { load } from './harness.mjs';

const ctx = load();

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const APP_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const NOW = 1_800_000_000;

function decode(segment) {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

describe('buildJwt', () => {
  const token = ctx.buildJwt(APP_ID, privateKey, NOW);
  const [headerPart, payloadPart, signaturePart] = token.split('.');

  it('produces three base64url segments', () => {
    expect(token.split('.')).toHaveLength(3);
  });

  it('never emits base64 padding, which JWT forbids', () => {
    // A token rejected for padding is indistinguishable from one rejected
    // for a bad signature, so this is worth asserting rather than assuming.
    expect(token).not.toContain('=');
    expect(token).not.toContain('+');
    expect(token).not.toContain('/');
  });

  it('puts the application ID in kid, which is what selects the environment', () => {
    const header = decode(headerPart);
    expect(header).toEqual({ typ: 'JWT', alg: 'RS256', kid: APP_ID });
  });

  it('sets the claims Enable Banking expects', () => {
    const payload = decode(payloadPart);
    expect(payload.iss).toBe('enablebanking.com');
    expect(payload.aud).toBe('api.enablebanking.com');
    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + 3600);
  });

  it('honours a custom TTL', () => {
    const short = ctx.buildJwt(APP_ID, privateKey, NOW, 60);
    expect(decode(short.split('.')[1]).exp).toBe(NOW + 60);
  });

  it('signs exactly the bytes it transmits', () => {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerPart}.${payloadPart}`);

    const signature = Buffer.from(
      signaturePart.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (signaturePart.length % 4)) % 4),
      'base64'
    );

    expect(verifier.verify(publicKey, signature)).toBe(true);
  });

  it('is deterministic for the same inputs', () => {
    expect(ctx.buildJwt(APP_ID, privateKey, NOW)).toBe(ctx.buildJwt(APP_ID, privateKey, NOW));
  });

  it('refuses to build a token it knows is invalid', () => {
    expect(() => ctx.buildJwt('', privateKey, NOW)).toThrow(/applicationId/);
    expect(() => ctx.buildJwt(APP_ID, '', NOW)).toThrow(/privateKey/);
    expect(() => ctx.buildJwt(APP_ID, privateKey, 0)).toThrow(/nowSeconds/);
    expect(() => ctx.buildJwt(APP_ID, privateKey, -1)).toThrow(/nowSeconds/);
  });
});

describe('decodeJwtPayload', () => {
  it('round-trips the claims', () => {
    const token = ctx.buildJwt(APP_ID, privateKey, NOW);
    expect(ctx.decodeJwtPayload(token)).toEqual({
      iss: 'enablebanking.com',
      aud: 'api.enablebanking.com',
      iat: NOW,
      exp: NOW + 3600
    });
  });

  it('rejects something that is not a JWT', () => {
    expect(() => ctx.decodeJwtPayload('nope')).toThrow(/not a JWT/);
  });
});
