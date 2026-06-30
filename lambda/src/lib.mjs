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

// Build a small text/plain notice for a message too large to forward whole.
// It threads correctly (From our domain, Reply-To the original sender) and
// tells the recipient exactly where to fetch the full original, so a large
// email is never silently lost. `headerRaw` need only contain the headers.
export function oversizeNotice({ headerRaw, fromAddress, destinations, bucket, key, sizeBytes }) {
  const h = parseHeaders(headerRaw, ["from", "subject", "date"]);
  const originalFrom = h.from || "";
  const subject = h.subject || "(no subject)";
  const date = h.date || "";
  const nameMatch = originalFrom.match(/^(.*?)\s*<.+>$/);
  const displayName = (nameMatch ? nameMatch[1] : originalFrom).replace(/"/g, "").trim();
  const fromDomain = fromAddress.split("@")[1];
  const newFrom = displayName
    ? `"${displayName} via ${fromDomain}" <${fromAddress}>`
    : `<${fromAddress}>`;
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

  const nameMatch = originalFrom.match(/^(.*?)\s*<.+>$/);
  const displayName = (nameMatch ? nameMatch[1] : originalFrom).replace(/"/g, "").trim();
  const fromDomain = fromAddress.split("@")[1];
  const newFrom = displayName
    ? `From: "${displayName} via ${fromDomain}" <${fromAddress}>`
    : `From: <${fromAddress}>`;

  header = header
    .replace(/^Return-Path:.*(\r?\n)?/gim, "")
    .replace(/^Sender:.*(\r?\n)?/gim, "")
    .replace(/^DKIM-Signature:.*(\r?\n(\s+.*)?)*(\r?\n)?/gim, "")
    .replace(/^X-SES-.*(\r?\n)?/gim, "")
    .replace(/^From:\s*(.*(?:\r?\n\s+.*)*)/im, newFrom);

  if (!/^Reply-To:/im.test(header) && originalFrom) {
    header = header.replace(/^From:.*$/im, (m) => `${m}\r\nReply-To: ${originalFrom}`);
  }

  return header + body;
}
