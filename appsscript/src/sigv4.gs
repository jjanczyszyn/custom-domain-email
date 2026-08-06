/**
 * sigv4.gs — AWS Signature Version 4 request signing.
 *
 * The crypto primitives are injected rather than called directly, so this file
 * runs unchanged under both Apps Script (Utilities.*) and Node (node:crypto).
 * That is the whole point: signature mismatches are unforgiving and nearly
 * impossible to debug from inside the Apps Script editor, so the algorithm is
 * verified against AWS's own published test vectors under Node instead.
 *
 * See docs/relay-premortem.md item 7.
 *
 * The injected `crypto` object must provide:
 *   sha256Hex(string)            -> lowercase hex digest
 *   hmac(keyBytes, string)       -> signature as an array of bytes
 *   toBytes(string)              -> UTF-8 bytes of a string
 *   hex(bytes)                   -> lowercase hex of a byte array
 */

var SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';

/** '20260806T142530Z' and '20260806' from a Date, as SigV4 requires. */
function sigv4Timestamps(date) {
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  var amz =
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    'T' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return { amzDate: amz, dateStamp: amz.slice(0, 8) };
}

/**
 * Canonical request per the SigV4 spec. Header names are lowercased, values
 * are trimmed with internal whitespace collapsed, and headers are sorted by
 * name — the ordering is part of what gets signed.
 */
function canonicalRequest(crypto, req) {
  var byLowerName = {};
  var names = [];
  for (var k in req.headers) {
    if (!req.headers.hasOwnProperty(k)) continue;
    var lower = k.toLowerCase();
    byLowerName[lower] = String(req.headers[k]);
    names.push(lower);
  }
  names.sort();

  var canonicalHeaders = '';
  for (var i = 0; i < names.length; i++) {
    canonicalHeaders += names[i] + ':' + byLowerName[names[i]].trim().replace(/\s+/g, ' ') + '\n';
  }

  var signedHeaders = names.join(';');
  var payloadHash = crypto.sha256Hex(req.body || '');

  var canonical = [
    req.method,
    req.path,
    req.query || '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  return { canonical: canonical, signedHeaders: signedHeaders, payloadHash: payloadHash };
}

/** The chained HMAC that derives the per-day, per-region, per-service key. */
function signingKey(crypto, secretKey, dateStamp, region, service) {
  var kDate = crypto.hmac(crypto.toBytes('AWS4' + secretKey), dateStamp);
  var kRegion = crypto.hmac(kDate, region);
  var kService = crypto.hmac(kRegion, service);
  return crypto.hmac(kService, 'aws4_request');
}

/**
 * Sign a request and return the headers to send with it, including
 * Authorization. Pure: give it the same inputs and it yields the same bytes,
 * which is what makes the test vectors meaningful.
 */
function signRequest(crypto, req, creds, date) {
  var ts = sigv4Timestamps(date);
  var headers = {};
  for (var k in req.headers) if (req.headers.hasOwnProperty(k)) headers[k] = req.headers[k];
  headers['x-amz-date'] = ts.amzDate;
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;

  var cr = canonicalRequest(crypto, {
    method: req.method,
    path: req.path,
    query: req.query,
    headers: headers,
    body: req.body,
  });

  var scope = ts.dateStamp + '/' + creds.region + '/' + creds.service + '/aws4_request';
  var stringToSign = [
    SIGV4_ALGORITHM,
    ts.amzDate,
    scope,
    crypto.sha256Hex(cr.canonical),
  ].join('\n');

  var key = signingKey(crypto, creds.secretKey, ts.dateStamp, creds.region, creds.service);
  var signature = crypto.hex(crypto.hmac(key, stringToSign));

  headers['Authorization'] =
    SIGV4_ALGORITHM +
    ' Credential=' + creds.accessKey + '/' + scope +
    ', SignedHeaders=' + cr.signedHeaders +
    ', Signature=' + signature;

  return { headers: headers, signature: signature, canonical: cr.canonical, stringToSign: stringToSign };
}

if (typeof module !== 'undefined') {
  module.exports = Object.assign(module.exports || {}, {
    SIGV4_ALGORITHM: SIGV4_ALGORITHM,
    sigv4Timestamps: sigv4Timestamps,
    canonicalRequest: canonicalRequest,
    signingKey: signingKey,
    signRequest: signRequest,
  });
}
