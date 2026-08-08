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

/**
 * Format a From header.
 *
 * A configured per-domain name wins: it is the brand the recipient should see,
 * and it beats both the draft's own display name (which is the Gmail account
 * holder's) and the bare address. With no name at all, mail clients fall back
 * to showing the local part — "hello" — which is why this matters.
 */
function fromHeaderValue(originalFrom, address, displayName) {
  var name = displayName ? String(displayName).trim() : '';
  if (!name) {
    var m = String(originalFrom || '').match(/^\s*("?)(.*?)\1\s*<[^>]*>\s*$/);
    if (m && m[2].trim()) name = m[2].trim();
  }
  if (!name) return address;
  return '"' + name.replace(/"/g, '') + '" <' + address + '>';
}

/** Parse the DOMAINS property: "example.com, example.net" -> array. */
function parseDomainList(value) {
  return String(value || '')
    .split(',')
    .map(function (d) { return d.trim(); })
    .filter(function (d) { return d.length > 0; });
}

/**
 * Parse the DOMAIN_NAMES property: "example.com=Example Co,example.net=Ex Net".
 * Keys are lowercased so lookups are case-insensitive.
 */
function parseDomainNames(value) {
  var map = {};
  var entries = String(value || '').split(',');
  for (var i = 0; i < entries.length; i++) {
    var eq = entries[i].indexOf('=');
    if (eq === -1) continue;
    var domain = entries[i].slice(0, eq).trim().toLowerCase();
    var name = entries[i].slice(eq + 1).trim();
    if (domain && name) map[domain] = name;
  }
  return map;
}

/** The configured display name for an address's domain, or '' if none. */
function displayNameFor(address, domainNames) {
  var at = String(address || '').indexOf('@');
  if (at === -1) return '';
  var domain = address.slice(at + 1).toLowerCase();
  return (domainNames && domainNames[domain]) || '';
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
 * Move stray </body></html> tags to the end of an HTML fragment.
 *
 * Gmail's stored draft closes the document *before* the quoted reply:
 *
 *   <html><body><div>your text</div></body></html>
 *   <br><div class="gmail_extra">…quote…</div>
 *
 * Everything after </html> is outside the document. Gmail's own sender
 * normalises this on the way out; the relay bypasses that sender, so the
 * malformed markup reaches the recipient, whose client then collapses the
 * whole body behind a "trimmed content" marker — the message looks empty.
 *
 * Content is never added or removed, only the closing tags are relocated.
 */
function fixStrayClosingTags(html) {
  if (!/<\/html\s*>/i.test(html)) return html;

  // Nothing of substance after the close: already well-formed, leave it alone.
  var trailing = html.replace(/[\s\S]*<\/html\s*>/i, '');
  if (!/\S/.test(trailing)) return html;

  var cleaned = html.replace(/<\/body\s*>/gi, '').replace(/<\/html\s*>/gi, '');
  return cleaned.replace(/\s+$/, '') + '</body></html>';
}

// ── Transfer-encoding codecs ─────────────────────────────────────────────────
//
// The repair below must see the DECODED part, not its wire form. Both of the
// encodings Gmail uses defeat a regex over raw bytes: quoted-printable's soft
// line breaks can split a closing tag ("</bo=\r\ndy>"), and base64 — which
// Gmail picks for any emoji-heavy text part, not just attachments — hides the
// markup entirely. Every emoji reply shipped unrepaired that way, and arrived
// looking empty.
//
// The codecs work on "binary strings" (one char per byte, no UTF-8
// interpretation). The repair only relocates ASCII tags, so non-ASCII bytes
// pass through untouched and nothing here needs a Unicode round-trip. Pure JS,
// no Utilities/Buffer, so Node tests exercise the exact code Apps Script runs.

var B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard or web-safe base64 to a binary string. Whitespace tolerated. */
function base64DecodeBinary(encoded) {
  var s = String(encoded).replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  var out = '';
  var buffer = 0;
  var bits = 0;
  for (var i = 0; i < s.length; i++) {
    var v = B64_ALPHABET.indexOf(s.charAt(i));
    if (v === -1) return null; // not base64 after all; let the caller leave it alone
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/** Binary string to base64, wrapped at 76 columns as RFC 2045 requires. */
function base64EncodeBinary(binary) {
  var out = '';
  var i;
  for (i = 0; i + 2 < binary.length; i += 3) {
    var n = (binary.charCodeAt(i) << 16) | (binary.charCodeAt(i + 1) << 8) | binary.charCodeAt(i + 2);
    out += B64_ALPHABET.charAt((n >> 18) & 63) + B64_ALPHABET.charAt((n >> 12) & 63) +
           B64_ALPHABET.charAt((n >> 6) & 63) + B64_ALPHABET.charAt(n & 63);
  }
  var rest = binary.length - i;
  if (rest === 1) {
    var a = binary.charCodeAt(i);
    out += B64_ALPHABET.charAt((a >> 2) & 63) + B64_ALPHABET.charAt((a << 4) & 63) + '==';
  } else if (rest === 2) {
    var b = (binary.charCodeAt(i) << 8) | binary.charCodeAt(i + 1);
    out += B64_ALPHABET.charAt((b >> 10) & 63) + B64_ALPHABET.charAt((b >> 4) & 63) +
           B64_ALPHABET.charAt((b << 2) & 63) + '=';
  }
  return out.replace(/(.{76})(?=.)/g, '$1\r\n');
}

/** Quoted-printable to a binary string: soft breaks removed, =XX decoded. */
function qpDecodeBinary(encoded) {
  return String(encoded)
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, function (m, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    });
}

/**
 * Binary string to quoted-printable: RFC 2045 encoding, lines wrapped at 76
 * with soft breaks, trailing whitespace on a line always encoded.
 */
function qpEncodeBinary(binary) {
  var HEX = '0123456789ABCDEF';
  var encoded = '';
  var i;
  for (i = 0; i < binary.length; i++) {
    var c = binary.charCodeAt(i);
    var isCrlf = c === 13 && binary.charCodeAt(i + 1) === 10;
    if (isCrlf) {
      encoded += '\r\n';
      i++;
    } else if (c === 9 || c === 32) {
      // Space and tab are literal except before a line break, where they must
      // be encoded or the receiver is entitled to strip them.
      var next = binary.charCodeAt(i + 1);
      var atEol = i + 1 === binary.length || (next === 13 && binary.charCodeAt(i + 2) === 10);
      encoded += atEol ? '=' + HEX.charAt(c >> 4) + HEX.charAt(c & 15) : binary.charAt(i);
    } else if (c >= 33 && c <= 126 && c !== 61) {
      encoded += binary.charAt(i);
    } else {
      encoded += '=' + HEX.charAt(c >> 4) + HEX.charAt(c & 15);
    }
  }

  // Wrap: no encoded line may exceed 76 chars including its trailing '='.
  var out = '';
  var lines = encoded.split('\r\n');
  for (i = 0; i < lines.length; i++) {
    var line = lines[i];
    while (line.length > 75) {
      var cut = 75;
      // Never split an =XX escape across the soft break.
      if (line.charAt(cut - 1) === '=') cut -= 1;
      else if (line.charAt(cut - 2) === '=') cut -= 2;
      out += line.slice(0, cut) + '=\r\n';
      line = line.slice(cut);
    }
    out += line + (i < lines.length - 1 ? '\r\n' : '');
  }
  return out;
}

/**
 * Apply the repair to every part of a message, leaving MIME structure intact.
 * Splits on boundary lines rather than parsing MIME, so nested multiparts and
 * unknown content types pass through untouched.
 *
 * Only text/html parts are examined — the collapse this repairs is an HTML
 * phenomenon — and each is examined in DECODED form: quoted-printable and
 * base64 parts are decoded, repaired, and re-encoded, but re-encoded ONLY
 * when the repair actually changed something, so an already-well-formed part
 * ships byte-identical. Attachments never qualify (wrong content type) and
 * are never decoded. `outerHeader` supplies the message's own header block so
 * a single-part message — whose Content-Type lives there rather than in any
 * part — is treated the same way.
 */
function repairHtmlParts(raw, outerHeader) {
  var segments = String(raw).split(/(\r?\n--[^\r\n]*(?:\r?\n|$))/);

  for (var i = 0; i < segments.length; i++) {
    if (/^\r?\n--/.test(segments[i])) continue; // a boundary, not content
    if (!segments[i]) continue;

    // Does this segment open with its own header block?
    var m = segments[i].match(/^([A-Za-z][A-Za-z0-9-]*:[^\r\n]*(?:\r?\n(?:[A-Za-z][A-Za-z0-9-]*:[^\r\n]*|[ \t][^\r\n]*))*\r?\n)\r?\n([\s\S]*)$/);
    var partHeader = m ? m[1] : '';
    var partBody = m ? m[2] : segments[i];
    var headerForPart = partHeader || String(outerHeader || '');

    var repaired = repairOnePart(headerForPart, partBody);
    if (repaired !== partBody) {
      // Splice the repaired body back after the untouched header bytes.
      segments[i] = m
        ? segments[i].slice(0, segments[i].length - partBody.length) + repaired
        : repaired;
    }
  }
  return segments.join('');
}

/** Repair a single part's body according to its declared type and encoding. */
function repairOnePart(header, body) {
  var contentType = readHeader(header, 'Content-Type');

  // No declared type at all: legacy posture — try the repair on the bare text.
  // This keeps preambles and header-less fragments behaving as they always
  // have, where the regex either fixes plain HTML or harmlessly matches
  // nothing.
  if (!contentType) return fixStrayClosingTags(body);

  if (!/text\/html/i.test(contentType)) return body;

  var encoding = readHeader(header, 'Content-Transfer-Encoding').toLowerCase();
  if (encoding === 'base64') {
    var decoded = base64DecodeBinary(body);
    if (decoded === null) return body; // not decodable; do no harm
    var fixed = fixStrayClosingTags(decoded);
    return fixed === decoded ? body : base64EncodeBinary(fixed);
  }
  if (encoding === 'quoted-printable') {
    var qpDecoded = qpDecodeBinary(body);
    var qpFixed = fixStrayClosingTags(qpDecoded);
    return qpFixed === qpDecoded ? body : qpEncodeBinary(qpFixed);
  }
  // 7bit/8bit/binary/absent: the bytes are the text.
  return fixStrayClosingTags(body);
}

/**
 * The Message-IDs a reply cites, newest first.
 *
 * In-Reply-To names the immediate parent; References is the chain, oldest
 * first. Newest is the strongest evidence of which conversation this answers,
 * so the chain is reversed and the direct parent leads.
 */
function messageIdReferences(header) {
  var inReplyTo = readHeader(header, 'In-Reply-To');
  var references = readHeader(header, 'References');
  var out = [];
  var seen = {};

  var ordered = (inReplyTo.match(/<[^>]+>/g) || [])
    .concat((references.match(/<[^>]+>/g) || []).reverse());

  for (var i = 0; i < ordered.length; i++) {
    var id = ordered[i].replace(/^</, '').replace(/>$/, '');
    if (id && !seen[id]) {
      seen[id] = true;
      out.push(id);
    }
  }
  return out;
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

  // Gmail's draft markup closes the document before the quoted reply. Left
  // alone, recipients see an apparently empty message. See fixStrayClosingTags.
  // The header rides along so a single-part message's Content-Type — declared
  // there rather than in any part — still routes it through the right decoder.
  var body = repairHtmlParts(parts.body, parts.header);

  var recipients = collectRecipients(header);
  var originalFrom = readHeader(header, 'From');

  // Headers that describe the old envelope or a signature over the old bytes.
  // Leaving any of these makes the message inconsistent once we rewrite From.
  header = stripHeader(header, 'Return-Path');
  header = stripHeader(header, 'Sender');
  header = stripHeader(header, 'DKIM-Signature');
  header = stripHeader(header, 'X-Google-.*');
  header = stripHeader(header, 'Received');

  var fromValue = fromHeaderValue(
    originalFrom,
    options.from,
    displayNameFor(options.from, options.domainNames)
  );
  header = setHeader(header, 'From', fromValue);

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

    // The fully formatted From, display name and all. SES's FromEmailAddress
    // parameter OVERRIDES the From header in the raw message, so the caller
    // must hand SES this value rather than the bare address — otherwise every
    // message goes out with the header we carefully built silently replaced.
    from: fromValue,
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
    parseDomainList: parseDomainList,
    parseDomainNames: parseDomainNames,
    messageIdReferences: messageIdReferences,
    displayNameFor: displayNameFor,
    fixStrayClosingTags: fixStrayClosingTags,
    repairHtmlParts: repairHtmlParts,
    repairOnePart: repairOnePart,
    base64DecodeBinary: base64DecodeBinary,
    base64EncodeBinary: base64EncodeBinary,
    qpDecodeBinary: qpDecodeBinary,
    qpEncodeBinary: qpEncodeBinary,
    inferDomainFromText: inferDomainFromText,
    normalizeBase64: normalizeBase64,
    utf8ByteLength: utf8ByteLength,
    isOversize: isOversize,
    buildOutbound: buildOutbound,
    validateRecipients: validateRecipients,
  });
}
