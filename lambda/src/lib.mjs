// Pure, side-effect-free logic for the email forwarder.
// Kept separate from index.mjs so it can be unit-tested without AWS.

// Match each recipient to its destinations, falling back to the "@<domain>"
// catch-all. Returns { destinations, fromDomain }. fromDomain is the recipient
// domain we re-send from, so DKIM stays aligned per domain.
export function resolve(recipients, mapping) {
  const destinations = new Set();
  let fromDomain = null;
  for (const rcpt of recipients) {
    const addr = String(rcpt).toLowerCase().trim();
    const domain = addr.split("@")[1];
    if (!domain) continue;
    const dests = mapping[addr] || mapping[`@${domain}`];
    if (dests && dests.length) {
      dests.forEach((d) => destinations.add(d));
      fromDomain = fromDomain || domain;
    }
  }
  return { destinations: [...destinations], fromDomain };
}

// SES SendRawEmail rejects anything over 10 MiB, but SES *inbound* accepts up
// to 40 MiB, so a 10-40 MiB message arrives fine and then fails to forward.
// We treat anything within SAFETY_MARGIN of the hard limit as oversize and
// deliver a notice instead of throwing (which would drop the mail).
export const SES_MAX_RAW_BYTES = 10 * 1024 * 1024;
const SAFETY_MARGIN = 256 * 1024; // headroom for any headers SES adds on send.
// The size a forwarded message must come in under, both to decide oversize and
// as the target the recompressor aims for.
export const FORWARD_TARGET_BYTES = SES_MAX_RAW_BYTES - SAFETY_MARGIN;

export function isOversize(byteLength) {
  return byteLength > FORWARD_TARGET_BYTES;
}

// Pull a few top-level headers out of a raw message without a MIME parser.
// Returns lowercased-key map; handles folded (continuation) header lines.
export function parseHeaders(raw, names) {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0];
  const out = {};
  for (const name of names) {
    const re = new RegExp(`^${name}:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, "im");
    const m = headerBlock.match(re);
    if (m) out[name.toLowerCase()] = m[1].replace(/\r?\n[ \t]+/g, " ").trim();
  }
  return out;
}

// Build the rewritten `From` value: our verified address, carrying the
// original sender's display name ("Jane via ourdomain") so the inbox still
// shows who really wrote. Shared by every path that re-sends from our domain.
export function fromHeaderValue(originalFrom, fromAddress) {
  const nameMatch = originalFrom.match(/^(.*?)\s*<.+>$/);
  const displayName = (nameMatch ? nameMatch[1] : originalFrom).replace(/"/g, "").trim();
  const fromDomain = fromAddress.split("@")[1];
  return displayName
    ? `"${displayName} via ${fromDomain}" <${fromAddress}>`
    : `<${fromAddress}>`;
}

// Build a small text/plain notice for a message too large to forward whole.
// It threads correctly (From our domain, Reply-To the original sender) and
// tells the recipient exactly where to fetch the full original, so a large
// email is never silently lost. `headerRaw` need only contain the headers.
export function oversizeNotice({ headerRaw, fromAddress, destinations, bucket, key, sizeBytes }) {
  const h = parseHeaders(headerRaw, ["from", "subject", "date"]);
  const originalFrom = h.from || "";
  const subject = h.subject || "(no subject)";
  const date = h.date || "";
  const newFrom = fromHeaderValue(originalFrom, fromAddress);
  const mb = (sizeBytes / (1024 * 1024)).toFixed(1);

  const lines = [
    `From: ${newFrom}`,
    originalFrom ? `Reply-To: ${originalFrom}` : null,
    `To: ${destinations.join(", ")}`,
    `Subject: [Large email — not auto-forwarded] ${subject}`,
    date ? `Date: ${date}` : null,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    `A message addressed to you was ${mb} MB — over the 10 MB limit for`,
    `automatic forwarding — so it could not be delivered whole to your inbox.`,
    `The full original (with attachments) is archived permanently:`,
    "",
    `  From:    ${originalFrom || "(unknown)"}`,
    `  Subject: ${subject}`,
    date ? `  Date:    ${date}` : null,
    `  Size:    ${mb} MB`,
    "",
    `Retrieve it from the AWS account, then open it in any mail client:`,
    "",
    `  aws s3 cp s3://${bucket}/${key} ./email.eml`,
    "",
  ].filter((l) => l !== null);

  return lines.join("\r\n");
}

// True if any recipient is the heartbeat probe address (probe@<domain>).
export function isProbe(recipients, probeLocalpart) {
  if (!probeLocalpart) return false;
  return recipients.some(
    (r) => String(r).toLowerCase().split("@")[0] === probeLocalpart.toLowerCase()
  );
}

// Re-send FROM our verified domain (so it is not flagged as spoofed) while
// preserving the original sender in Reply-To. Strips headers that no longer
// apply once the envelope changes.
export function rewrite(raw, fromAddress) {
  const split = raw.match(/^((?:.+\r?\n)*?)(\r?\n[\s\S]*)$/);
  let header = split ? split[1] : raw;
  const body = split ? split[2] : "";

  let originalFrom = "";
  const fromMatch = header.match(/^From:\s*(.*(?:\r?\n\s+.*)*)/im);
  if (fromMatch) originalFrom = fromMatch[1].replace(/\r?\n\s+/g, " ").trim();

  const newFrom = `From: ${fromHeaderValue(originalFrom, fromAddress)}`;

  header = header
    .replace(/^Return-Path:.*(\r?\n)?/gim, "")
    .replace(/^Sender:.*(\r?\n)?/gim, "")
    .replace(/^DKIM-Signature:.*(\r?\n(\s+.*)?)*(\r?\n)?/gim, "")
    .replace(/^X-SES-.*(\r?\n)?/gim, "")
    .replace(/^From:\s*(.*(?:\r?\n\s+.*)*)/im, newFrom);

  if (!/^Reply-To:/im.test(header) && originalFrom) {
    header = header.replace(/^From:.*$/im, (m) => `${m}\r\nReply-To: ${originalFrom}`);
  }

  // Strip addresses SES can't parse from the recipient headers (see
  // sanitizeAddressHeaders): one malformed token would otherwise make SES
  // reject the entire send and the mail would never reach the inbox.
  header = sanitizeAddressHeaders(header);

  // Keep Gmail from answering an invitation as the wrong identity.
  return defuseCalendarInvites(header + body);
}

// SES parses the To/Cc/Bcc headers out of the raw message when it sends and
// rejects the WHOLE message if any address is malformed — e.g. a mail client
// that emits a broken "<undisclosed-recipients:>" group (a colon where the
// domain should be). Actual delivery is driven by the SendRawEmail
// `Destinations` API parameter, NOT these headers, so we can safely drop any
// address SES would choke on and keep the well-formed ones. This turns a hard
// "InvalidParameterValue: Local address contains illegal character" failure
// into a clean send. A header left with no valid addresses is removed whole.
const ADDR_SPEC = /^[^\s<>@",]+@[^\s<>@",]+\.[^\s<>@",]+$/;

// Split an address-list value into individual address tokens. Commas inside a
// quoted display name or inside <angle brackets> do not separate addresses.
export function splitAddressList(value) {
  const out = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of value) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    else if (ch === "," && !inQuote && !inAngle) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// The bare addr-spec of a token: the text inside <> if present, else the whole
// token (a plain "user@host" with no display name).
function addrSpecOf(token) {
  const m = token.match(/<([^>]*)>/);
  return (m ? m[1] : token).trim();
}

export function sanitizeAddressHeaders(header) {
  return header.replace(
    /^(To|Cc|Bcc):[ \t]*(.*(?:\r?\n[ \t].*)*)(\r?\n|$)/gim,
    (full, name, value, nl) => {
      const unfolded = value.replace(/\r?\n[ \t]+/g, " ");
      const kept = splitAddressList(unfolded)
        .map((t) => t.trim())
        .filter((t) => t && ADDR_SPEC.test(addrSpecOf(t)));
      // No parseable address left — drop the header (consuming its newline);
      // Destinations still carries the mail to the right inbox.
      if (kept.length === 0) return "";
      return `${name}: ${kept.join(", ")}${nl}`;
    }
  );
}

// Last-resort delivery: wrap the untouched original as a message/rfc822
// attachment inside an envelope whose headers we fully control. Used when SES
// rejects even the sanitized raw message — no header the original carried can
// reach SES's address parser, so the send always succeeds and the recipient
// gets the real email as an openable attachment. Threads via Reply-To like
// every other path. `raw` is the full original (Buffer or string).
export function wrapAsAttachment(raw, { fromAddress, destinations, boundary = "=_forward_original_boundary_" }) {
  const rawStr = typeof raw === "string" ? raw : raw.toString("utf-8");
  const h = parseHeaders(rawStr, ["from", "subject"]);
  const originalFrom = h.from || "";
  const subject = h.subject || "(no subject)";
  const b64 = Buffer.from(raw).toString("base64").replace(/(.{76})/g, "$1\r\n");

  const lines = [
    `From: ${fromHeaderValue(originalFrom, fromAddress)}`,
    originalFrom ? `Reply-To: ${originalFrom}` : null,
    `To: ${destinations.join(", ")}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "This message reached your domain, but its original headers could not be",
    "re-sent directly, so the complete original is attached below — open the",
    "attachment to read it. Reply-To is set to the original sender.",
    "",
    `--${boundary}`,
    "Content-Type: message/rfc822",
    'Content-Disposition: attachment; filename="original.eml"',
    "Content-Transfer-Encoding: base64",
    "",
    b64,
    `--${boundary}--`,
    "",
  ].filter((l) => l !== null);

  return Buffer.from(lines.join("\r\n"));
}

// Gmail draws an inline RSVP card ("Yes / Maybe / No") for any text/calendar
// part and answers it as the *signed-in account*. A forwarded invitation is
// addressed to an address on our domain, not to the Gmail account reading it,
// so answering from the card RSVPs as the Gmail address — the organizer sees
// the wrong person accept, and the invited address stays "awaiting reply".
//
// Demote the invitation part to a plain .ics attachment: the card disappears,
// the invitation is still readable and importable, and the RSVP happens where
// it belongs — on the calendar of the address that was actually invited (for a
// Google-organised event Google has already delivered it there directly).
const CALENDAR_PART = /^Content-Type:[ \t]*text\/calendar\b[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*/gim;

export function defuseCalendarInvites(raw) {
  return raw.replace(CALENDAR_PART, (match, offset, str) => {
    const rest = str.slice(offset + match.length);
    const nl = rest.startsWith("\r\n") ? "\r\n" : "\n";
    // The remaining headers of this MIME part, i.e. up to the blank line that
    // starts its body — that is the only place a Content-Disposition of ours
    // would be a duplicate.
    const blockEnd = rest.search(/\r?\n\r?\n/);
    const partHeaders = blockEnd === -1 ? rest : rest.slice(0, blockEnd);
    const typed = 'Content-Type: application/ics; charset="UTF-8"; name="invitation.ics"';
    return /^Content-Disposition:/im.test(partHeaders)
      ? typed
      : `${typed}${nl}Content-Disposition: attachment; filename="invitation.ics"`;
  });
}
