/**
 * aws.gs — the AWS I/O shell: crypto primitives, SES send, CloudWatch metric.
 *
 * All signing logic lives in sigv4.gs and is unit-tested under Node. This file
 * is the thin layer that supplies Apps Script's crypto implementation and
 * performs the actual HTTP calls, mirroring how lambda/src keeps index.mjs a
 * shell over the tested lib.mjs.
 */

/** Signed bytes (-128..127) to lowercase hex. */
function bytesToHex(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

/** The crypto adapter sigv4.gs expects, backed by Apps Script's Utilities. */
var AppsScriptCrypto = {
  sha256Hex: function (str) {
    return bytesToHex(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8)
    );
  },
  hmac: function (keyBytes, msg) {
    return Utilities.computeHmacSha256Signature(Utilities.newBlob(msg).getBytes(), keyBytes);
  },
  toBytes: function (str) {
    return Utilities.newBlob(str).getBytes();
  },
  hex: function (bytes) {
    return bytesToHex(bytes);
  },
};

/** Issue a signed request. Returns { status, body }. */
function awsFetch(cfg, service, host, path, body, contentType) {
  var signed = signRequest(
    AppsScriptCrypto,
    {
      method: 'POST',
      path: path,
      query: '',
      headers: { Host: host, 'Content-Type': contentType },
      body: body,
    },
    {
      accessKey: cfg.accessKey,
      secretKey: cfg.secretKey,
      region: cfg.region,
      service: service,
    },
    new Date()
  );

  var response = UrlFetchApp.fetch('https://' + host + path, {
    method: 'post',
    contentType: contentType,
    payload: body,
    headers: {
      Authorization: signed.headers.Authorization,
      'x-amz-date': signed.headers['x-amz-date'],
    },
    muteHttpExceptions: true,
  });

  return { status: response.getResponseCode(), body: response.getContentText() };
}

/**
 * Hand a raw message to SES for delivery.
 *
 * Recipients travel as API parameters, NOT as headers — that is what lets us
 * strip Bcc from the transmitted bytes while still delivering to the blind
 * recipients. See docs/relay-premortem.md item 2.
 *
 * `fromAddress` must be the FULLY FORMATTED From value, display name included.
 * FromEmailAddress overrides whatever the raw message's From header says, so
 * passing a bare address here silently discards the display name and every
 * message goes out showing the local part.
 *
 * Throws on any non-2xx so the caller can report the real error verbatim.
 */
function sesSendRaw(cfg, fromAddress, recipients, rawMessage) {
  var destination = {};
  if (recipients.to.length) destination.ToAddresses = recipients.to;
  if (recipients.cc.length) destination.CcAddresses = recipients.cc;
  if (recipients.bcc.length) destination.BccAddresses = recipients.bcc;

  var payload = JSON.stringify({
    FromEmailAddress: fromAddress,
    Destination: destination,
    Content: { Raw: { Data: Utilities.base64Encode(rawMessage, Utilities.Charset.UTF_8) } },
  });

  var host = 'email.' + cfg.region + '.amazonaws.com';
  var res = awsFetch(cfg, 'ses', host, '/v2/email/outbound-emails', payload, 'application/json');

  if (res.status < 200 || res.status >= 300) {
    var detail = res.body;
    try {
      var parsed = JSON.parse(res.body);
      detail = parsed.message || parsed.Message || res.body;
    } catch (e) {
      // Non-JSON error body; report it as-is.
    }
    throw new Error('SES returned ' + res.status + ': ' + detail);
  }

  var messageId = '';
  try {
    messageId = JSON.parse(res.body).MessageId || '';
  } catch (e) {
    // A 2xx with an unparseable body still means accepted.
  }
  return messageId;
}

/**
 * Report that the relay is alive, to CloudWatch.
 *
 * The watchdog deliberately lives outside Apps Script — a monitor inside the
 * thing it monitors cannot report that the thing is dead. The canary Lambda
 * reads this metric and emails when it stops appearing. See premortem item 3.
 *
 * Never throws: a monitoring failure must not stop mail going out.
 */
function putRelayHeartbeat(cfg, sentCount) {
  try {
    var params = [
      'Action=PutMetricData',
      'Version=2010-08-01',
      'Namespace=' + encodeURIComponent(cfg.metricNamespace),
      'MetricData.member.1.MetricName=RelayHeartbeat',
      'MetricData.member.1.Value=1',
      'MetricData.member.1.Unit=Count',
      'MetricData.member.2.MetricName=RelaySent',
      'MetricData.member.2.Value=' + sentCount,
      'MetricData.member.2.Unit=Count',
    ].join('&');

    awsFetch(
      cfg,
      'monitoring',
      'monitoring.' + cfg.region + '.amazonaws.com',
      '/',
      params,
      'application/x-www-form-urlencoded; charset=utf-8'
    );
  } catch (e) {
    console.warn('heartbeat failed: ' + errorText(e));
  }
}
