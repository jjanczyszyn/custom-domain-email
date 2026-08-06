/**
 * mime.gs — pure MIME/header logic for the outbound relay.
 *
 * Deliberately free of Apps Script APIs (no GmailApp, Utilities, UrlFetchApp)
 * so Node can load this file into a vm sandbox and unit-test it, the same way
 * lambda/src/lib.mjs keeps its logic testable and its handler a thin shell.
 *
 * Nothing here performs I/O. Everything is string in, string out.
 */

// SendRawEmail refuses anything larger. Same ceiling the inbound path works
// around in lib.mjs — SES receives 40 MB but only sends 10 MB.
var SES_MAX_RAW_BYTES = 10 * 1024 * 1024;

// Default subject-line marker. Works anywhere text can be typed, including the
// Gmail mobile compose view where labelling a draft is awkward or unavailable.
// Configurable per install via the SUBJECT_TOKEN script property; setting that
// to an empty string disables the marker entirely, leaving the label as the
// only way to send.
var DEFAULT_SUBJECT_TOKEN = '>>';

/** Split a raw RFC822 message into its header block and body. */
function splitMime(raw) {
  var m = raw.match(/^((?:.+\r?\n)*?)(\r?\n[\s\S]*)$/);
  if (!m) return { header: raw, body: '' };
  return { header: m[1], body: m[2] };
}

/**
 * Read a header, unfolding RFC822 continuation lines into one value.
 * Returns '' when absent.
 */
function readHeader(header, name) {
  var re = new RegExp('^' + name + ':\\s*(.*(?:\\r?\\n[ \\t]+.*)*)', 'im');
  var m = header.match(re);
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
}

/** Remove every instance of a header, including folded continuations. */
function stripHeader(header, name) {
  var re = new RegExp('^' + name + ':.*(?:\\r?\\n[ \\t]+.*)*(?:\\r?\\n)?', 'gim');
  return header.replace(re, '');
}

/** Replace a header's value, or append the header when it is absent. */
function setHeader(header, name, value) {
  var re = new RegExp('^' + name + ':.*(?:\\r?\\n[ \\t]+.*)*', 'im');
  if (re.test(header)) return header.replace(re, name + ': ' + value);
  return header.replace(/(\r?\n)?$/, '\r\n' + name + ': ' + value + '\r\n');
}

/**
 * Guarantee a Message-ID, generating one when the draft has none.
 *
 * We always want to own this value rather than let SES assign one: the copy
 * filed in Sent and the bytes actually transmitted must carry the SAME id, or
 * the recipient's reply cites an id we don't hold and the thread fragments.
 * See docs/relay-premortem.md item 4.
 */
function ensureMessageId(header, generated) {
  var existing = readHeader(header, 'Message-ID');
  if (existing) return { header: header, messageId: existing };
  return { header: setHeader(header, 'Message-ID', generated), messageId: generated };
}

/** Format a From header, preserving the draft's display name when present. */
function fromHeaderValue(originalFrom, address) {
  var name = '';
  var m = originalFrom.match(/^\s*("?)(.*?)\1\s*<[^>]*>\s*$/);
  if (m && m[2].trim()) name = m[2].trim();
  if (!name) return address;
  return '"' + name.replace(/"/g, '') + '" <' + address + '>';
}

/**
 * Split an address-list header into individual addresses, respecting quoted
 * display names and angle brackets so a comma inside "Doe, Jane" is not
 * treated as a separator.
 */
function splitAddressList(value) {
  var out = [];
  var current = '';
  var inQuotes = false;
  var depth = 0;
  for (var i = 0; i < value.length; i++) {
    var c = value.charAt(i);
    if (c === '"' && value.charAt(i - 1) !== '\\') inQuotes = !inQuotes;
    if (!inQuotes && c === '<') depth++;
    if (!inQuotes && c === '>') depth--;
    if (c === ',' && !inQuotes && depth <= 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Reduce a display-name address to its bare addr-spec. */
function bareAddress(value) {
  var m = value.match(/<([^>]*)>/);
  var addr = (m ? m[1] : value).trim();
  return addr.replace(/^["']|["']$/g, '');
}

/**
 * Is this something SES will accept as a recipient?
 *
 * Outbound is stricter than inbound on purpose. lib.mjs drops unparseable
 * addresses from inbound headers because delivery is driven by the envelope
 * and dropping one is harmless. Here a dropped address is a person who never
 * received your email, so callers surface the bad address instead.
 */
function isSendableAddress(addr) {
  if (!addr || addr.length > 254) return false;
  if (/[\s,;:<>\\"]/.test(addr)) return false;
  var parts = addr.split('@');
  if (parts.length !== 2) return false;
  if (!parts[0].length || !parts[1].length) return false;
  return /^[^.].*[^.]$|^[^.]$/.test(parts[0]) && /\./.test(parts[1]);
}

/** Collect the recipients of each class, bare and deduplicated. */
function collectRecipients(header) {
  function list(name) {
    var v = readHeader(header, name);
    if (!v) return [];
    var seen = {};
    var out = [];
    var items = splitAddressList(v);
    for (var i = 0; i < items.length; i++) {
      var a = bareAddress(items[i]);
      if (a && !seen[a.toLowerCase()]) {
        seen[a.toLowerCase()] = true;
        out.push(a);
      }
    }
    return out;
  }
  return { to: list('To'), cc: list('Cc'), bcc: list('Bcc') };
}

/**
 * Parse the subject marker.
 *
 * '>>Subject'                    -> send, alias inferred from the thread
 * '>>example.net Subject'        -> send as hello@example.net
 * '>>hello@example.net Subject'  -> send as that exact address
 *
 * Returns the cleaned subject so the token never reaches the recipient.
 */
function parseSubjectToken(subject, domains, defaultLocalpart, token) {
  var marker = token === undefined ? DEFAULT_SUBJECT_TOKEN : token;
  var s = subject || '';

  // An empty marker disables the subject trigger, leaving the label as the only
  // way to send. Without this guard indexOf('') === 0 for every subject, which
  // would mark every draft in the mailbox for sending.
  if (!marker) return { marked: false, alias: null, subject: s };

  var trimmed = s.replace(/^\s+/, '');
  if (trimmed.indexOf(marker) !== 0) {
    return { marked: false, alias: null, subject: s };
  }
  var rest = trimmed.slice(marker.length);
  var m = rest.match(/^([A-Za-z0-9._%+-]*@?[A-Za-z0-9.-]+\.[A-Za-z]{2,})\s+([\s\S]*)$/);
  if (m) {
    var candidate = m[1];
    var alias = resolveAlias(candidate, domains, defaultLocalpart);
    if (alias) return { marked: true, alias: alias, subject: m[2].trim() };
  }
  return { marked: true, alias: null, subject: rest.replace(/^\s+/, '') };
}

/**
 * Turn 'example.net' or 'hello@example.net' into a full alias, but only when
 * the domain is one we are actually verified to send as. An unknown domain
 * returns null so the caller refuses rather than sending under a domain SES
 * will reject (or worse, one we don't own).
 */
function resolveAlias(candidate, domains, defaultLocalpart) {
  var localpart = defaultLocalpart;
  var domain = candidate;
  if (candidate.indexOf('@') !== -1) {
    var parts = candidate.split('@');
    localpart = parts[0];
    domain = parts[1];
  }
  domain = domain.toLowerCase();
  for (var i = 0; i < domains.length; i++) {
    if (domains[i].toLowerCase() === domain) return localpart + '@' + domains[i];
  }
  return null;
}

/**
 * Infer which alias a reply should go out as, from the addresses the thread
 * was originally delivered to. Mirrors Gmail's "reply from the same address
 * the message was sent to" behaviour.
 *
 * `candidates` is every To/Cc/Delivered-To address seen across the thread,
 * newest message first, so the most recent match wins.
 */
function inferAlias(candidates, domains, defaultLocalpart) {
  for (var i = 0; i < candidates.length; i++) {
    var addr = bareAddress(String(candidates[i] || ''));
    if (addr.indexOf('@') === -1) continue;
    var alias = resolveAlias(addr, domains, defaultLocalpart);
    if (alias) return alias;
  }
  return null;
}

/**
 * Normalise a base64url (web-safe) string to standard base64.
 *
 * The Gmail API returns raw messages base64url-encoded and unpadded. Apps
 * Script's base64DecodeWebSafe is fussy about both padding and stray
 * whitespace, and fails with a bare "Could not decode string" that says nothing
 * about which. Converting to padded standard base64 sidesteps it.
 */
function normalizeBase64(value) {
  var s = String(value == null ? '' : value).replace(/\s+/g, '');
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  return s;
}

/**
 * Find the first of our domains mentioned in a block of text.
 *
 * Last-resort inference for a reply Gmail never marked as one: no thread, no
 * In-Reply-To, no References — just the quoted attribution line ("On ... ,
 * X <someone@ourdomain> wrote:") naming the address the conversation ran through.
 *
 * Only the DOMAIN is taken, never the local part. An address found in a body is
 * almost always the parent's sender — typically the no-reply@ our own forwarder
 * rewrote it to — and sending as that would be wrong. The caller pairs the
 * domain with the configured default local part instead.
 */
function inferDomainFromText(text, domains) {
  var matches = String(text || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  for (var i = 0; i < matches.length; i++) {
    var domain = matches[i].split('@')[1].toLowerCase();
    for (var j = 0; j < domains.length; j++) {
      if (domains[j].toLowerCase() === domain) return domains[j];
    }
  }
  return null;
}

/** Byte length of a string as UTF-8, without needing Buffer or Blob. */
function utf8ByteLength(str) {
  var bytes = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

function isOversize(raw) {
  return utf8ByteLength(raw) > SES_MAX_RAW_BYTES;
}

/**
 * Build the two variants of the outgoing message.
 *
 *   transmit — what goes to SES. Bcc stripped from the headers entirely; the
 *              blind recipients travel as an API parameter instead, so they
 *              are never disclosed to anyone. See premortem item 2.
 *   archive  — what gets filed in Sent. Keeps Bcc, because you need to see who
 *              you blind-copied, exactly as Gmail shows it natively.
 *
 * Both share one Message-ID so replies thread against the archived copy.
 */
function buildOutbound(raw, options) {
  var parts = splitMime(raw);
  var header = parts.header;
  var body = parts.body;

  var recipients = collectRecipients(header);
  var originalFrom = readHeader(header, 'From');

  // Headers that describe the old envelope or a signature over the old bytes.
  // Leaving any of these makes the message inconsistent once we rewrite From.
  header = stripHeader(header, 'Return-Path');
  header = stripHeader(header, 'Sender');
  header = stripHeader(header, 'DKIM-Signature');
  header = stripHeader(header, 'X-Google-.*');
  header = stripHeader(header, 'Received');

  header = setHeader(header, 'From', fromHeaderValue(originalFrom, options.from));

  if (options.subject !== undefined && options.subject !== null) {
    header = setHeader(header, 'Subject', options.subject);
  }

  var withId = ensureMessageId(header, options.messageId);
  header = withId.header;

  var archive = header + body;
  var transmit = stripHeader(stripHeader(header, 'Bcc'), 'Resent-Bcc') + body;

  return {
    transmit: transmit,
    archive: archive,
    messageId: withId.messageId,
    recipients: recipients,
  };
}

/** Split recipients into deliverable and rejected, so callers can report. */
function validateRecipients(recipients) {
  var ok = { to: [], cc: [], bcc: [] };
  var bad = [];
  var classes = ['to', 'cc', 'bcc'];
  for (var i = 0; i < classes.length; i++) {
    var cls = classes[i];
    var list = recipients[cls] || [];
    for (var j = 0; j < list.length; j++) {
      if (isSendableAddress(list[j])) ok[cls].push(list[j]);
      else bad.push(list[j]);
    }
  }
  return { ok: ok, bad: bad, total: ok.to.length + ok.cc.length + ok.bcc.length };
}

// Exported for the Node test harness; ignored by Apps Script, which sees every
// top-level function as globally available anyway.
if (typeof module !== 'undefined') {
  module.exports = Object.assign(module.exports || {}, {
    SES_MAX_RAW_BYTES: SES_MAX_RAW_BYTES,
    DEFAULT_SUBJECT_TOKEN: DEFAULT_SUBJECT_TOKEN,
    splitMime: splitMime,
    readHeader: readHeader,
    stripHeader: stripHeader,
    setHeader: setHeader,
    ensureMessageId: ensureMessageId,
    fromHeaderValue: fromHeaderValue,
    splitAddressList: splitAddressList,
    bareAddress: bareAddress,
    isSendableAddress: isSendableAddress,
    collectRecipients: collectRecipients,
    parseSubjectToken: parseSubjectToken,
    resolveAlias: resolveAlias,
    inferAlias: inferAlias,
    inferDomainFromText: inferDomainFromText,
    normalizeBase64: normalizeBase64,
    utf8ByteLength: utf8ByteLength,
    isOversize: isOversize,
    buildOutbound: buildOutbound,
    validateRecipients: validateRecipients,
  });
}
