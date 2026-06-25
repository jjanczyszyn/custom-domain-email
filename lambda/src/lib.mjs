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
