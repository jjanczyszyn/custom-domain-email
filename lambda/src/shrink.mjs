// Oversize handling: when an inbound message is too big for SES SendRawEmail
// (10 MiB), recompress its images until the whole thing fits, then rebuild a
// clean, correctly-threaded email. Falls back to null when images can't get it
// under budget (e.g. a huge video) so the caller can link to the original.
//
// Heavier than lib.mjs (pulls in mailparser/jimp/nodemailer), kept separate so
// the pure routing logic stays dependency-free.
//
// Note: mailparser inlines related images into the HTML as base64 `data:` URIs.
// Gmail won't render `data:` image URIs in received mail, so we pull those back
// out, recompress them, and re-attach as proper `cid:` inline parts.
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { Jimp } from "jimp";

const RECOMPRESSIBLE = /^image\/(jpe?g|png|tiff|bmp|webp)$/i;
const DATA_URI = /data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/gi;

// Progressively more aggressive passes. The first that fits under budget wins,
// so normal photos stay near-original and only extreme cases get crushed.
const TIERS = [
  { maxDim: 3000, quality: 85 },
  { maxDim: 2400, quality: 80 },
  { maxDim: 1800, quality: 72 },
  { maxDim: 1280, quality: 65 },
];

// Mirror lib.mjs rewrite(): re-send from our verified domain, original sender
// preserved so replies still reach them.
function rewriteFrom(originalFromText, fromAddress) {
  const nameMatch = (originalFromText || "").match(/^(.*?)\s*<.+>$/);
  const displayName = (nameMatch ? nameMatch[1] : originalFromText || "").replace(/"/g, "").trim();
  const fromDomain = fromAddress.split("@")[1];
  return displayName ? `"${displayName} via ${fromDomain}" <${fromAddress}>` : `<${fromAddress}>`;
}

async function recompress(buffer, { maxDim, quality }) {
  const img = await Jimp.read(buffer);
  if (img.width > maxDim || img.height > maxDim) img.scaleToFit({ w: maxDim, h: maxDim });
  return img.getBuffer("image/jpeg", { quality });
}

// Replace each base64 `data:` image in the HTML with a recompressed cid: image.
// Returns { html, attachments } where attachments are inline parts.
async function inlineImagesToCid(html, tier, fromDomain) {
  const attachments = [];
  const matches = [...html.matchAll(DATA_URI)];
  let i = 0;
  let out = html;
  for (const m of matches) {
    const original = Buffer.from(m[1], "base64");
    const jpg = await recompress(original, tier);
    const cid = `inline-${i}@${fromDomain}`;
    attachments.push({
      filename: `inline-${i}.jpg`,
      content: jpg,
      contentType: "image/jpeg",
      cid,
      contentDisposition: "inline",
    });
    out = out.replace(m[0], `cid:${cid}`);
    i += 1;
  }
  return { html: out, attachments };
}

async function buildRaw(parsed, html, attachments, fromAddress, destinations) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const info = await transport.sendMail({
    from: rewriteFrom(parsed.from?.text, fromAddress),
    replyTo: parsed.from?.text || undefined,
    to: destinations.join(", "),
    subject: parsed.subject,
    text: parsed.text || "",
    html: html || undefined,
    date: parsed.date || undefined,
    inReplyTo: parsed.inReplyTo || undefined,
    references: parsed.references || undefined,
    attachments,
  });
  return info.message;
}

// Try to recompress `raw` so the rebuilt message is <= targetBytes. Returns
// { message: Buffer, tier, originalBytes, newBytes } or null when image
// recompression alone can't get it under budget.
export async function shrinkToFit(raw, { fromAddress, destinations, targetBytes }) {
  const parsed = await simpleParser(raw);
  const fromDomain = fromAddress.split("@")[1];

  // True (non-inline) attachments. simpleParser folds inline images into the
  // HTML, so anything left here is a real attachment.
  const realAtts = (parsed.attachments || []).filter((a) => !a.related);
  const hasInlineImages = DATA_URI.test(parsed.html || "");
  DATA_URI.lastIndex = 0; // reset after .test()
  const compressibleReal = realAtts.filter((a) => RECOMPRESSIBLE.test(a.contentType || ""));

  // Bytes we cannot shrink (non-image attachments) set a hard floor.
  const fixedBytes = realAtts
    .filter((a) => !RECOMPRESSIBLE.test(a.contentType || ""))
    .reduce((n, a) => n + (a.content?.length || 0), 0);
  if ((!hasInlineImages && compressibleReal.length === 0) || fixedBytes > targetBytes) return null;

  for (const tier of TIERS) {
    const { html, attachments } = await inlineImagesToCid(parsed.html || "", tier, fromDomain);
    for (const a of realAtts) {
      if (RECOMPRESSIBLE.test(a.contentType || "")) {
        const jpg = await recompress(a.content, tier);
        attachments.push({
          filename: (a.filename || "image").replace(/\.[^.]*$/, "") + ".jpg",
          content: jpg,
          contentType: "image/jpeg",
          contentDisposition: a.contentDisposition || "attachment",
        });
      } else {
        attachments.push({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
          cid: a.cid || undefined,
          contentDisposition: a.contentDisposition || "attachment",
        });
      }
    }
    const message = await buildRaw(parsed, html, attachments, fromAddress, destinations);
    if (message.length <= targetBytes) {
      return { message, tier, originalBytes: raw.length, newBytes: message.length };
    }
  }
  return null;
}
