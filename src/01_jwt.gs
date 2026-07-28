/**
 * 01_jwt.gs — RS256 JSON Web Tokens for Enable Banking.
 *
 * Every request carries `Authorization: Bearer <jwt>`, signed with the
 * private key you downloaded at application registration. There is no
 * client secret and no token endpoint: the JWT *is* the credential, minted
 * locally and short-lived.
 *
 * The `kid` header is the application ID, and that is what selects the
 * environment — sandbox and production share a base URL, so which key signs
 * the token determines which world you reach. Signing a sandbox request with
 * the production key doesn't fail differently; it just reaches production.
 */

var JWT_ISSUER = 'enablebanking.com';
var JWT_AUDIENCE = 'api.enablebanking.com';
var JWT_TTL_SECONDS = 3600;

/**
 * Build a signed JWT.
 *
 * `nowSeconds` is a parameter rather than read from the clock so the whole
 * function is deterministic and testable — the claims are the part worth
 * asserting on, and a token whose `exp` depends on when the test ran can't
 * be asserted at all.
 *
 * @param {string} applicationId  becomes the `kid` header
 * @param {string} privateKey     PEM contents, including the BEGIN/END lines
 * @param {number} nowSeconds     UNIX seconds
 * @param {number=} ttlSeconds    defaults to one hour
 * @return {string} header.payload.signature
 */
function buildJwt(applicationId, privateKey, nowSeconds, ttlSeconds) {
  if (!applicationId) throw new Error('buildJwt: applicationId is required');
  if (!privateKey) throw new Error('buildJwt: privateKey is required');
  if (!(nowSeconds > 0)) throw new Error('buildJwt: nowSeconds must be a positive UNIX timestamp');

  var ttl = ttlSeconds || JWT_TTL_SECONDS;

  var header = { typ: 'JWT', alg: 'RS256', kid: applicationId };
  var payload = {
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + ttl
  };

  var signingInput = base64Url(JSON.stringify(header)) + '.' + base64Url(JSON.stringify(payload));
  var signature = Utilities.computeRsaSha256Signature(signingInput, privateKey);

  return signingInput + '.' + base64Url(signature);
}

/**
 * base64url: URL-safe alphabet and, critically, **no padding**.
 *
 * `base64EncodeWebSafe` gives us `-`/`_` but keeps the `=` padding, which
 * JWT forbids. Servers differ in how forgiving they are about that, and a
 * token rejected for padding looks exactly like a token rejected for a bad
 * signature — so it's stripped here rather than debugged later.
 *
 * Accepts a string or a byte array, since the signature arrives as bytes.
 */
function base64Url(input) {
  return Utilities.base64EncodeWebSafe(input).replace(/=+$/, '');
}

/**
 * Decode a JWT's payload. Diagnostics only — this verifies nothing.
 *
 * Useful for answering "is my token already expired?" from the _tests tab
 * without pasting a live credential into a website to find out.
 */
function decodeJwtPayload(token) {
  var parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('decodeJwtPayload: not a JWT');

  var padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4 !== 0) padded += '=';

  var bytes = Utilities.base64Decode(padded);
  return JSON.parse(bytesToString_(bytes));
}

function bytesToString_(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i] < 0 ? bytes[i] + 256 : bytes[i]);
  }
  return decodeURIComponent(escape(s));
}
