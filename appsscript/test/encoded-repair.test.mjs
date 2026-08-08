import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGs } from "./helpers.mjs";

/**
 * The stray-closing-tag repair, applied through transfer encodings.
 *
 * Gmail's stored reply markup closes the HTML document before the quoted
 * history; unrepaired, recipients' clients collapse the entire body behind a
 * "trimmed content" ellipsis and the message looks empty. The repair existed —
 * but it pattern-matched the WIRE bytes, and both of Gmail's transfer
 * encodings defeat that: quoted-printable soft breaks can split a closing tag
 * across lines, and base64 (Gmail's choice for emoji-heavy text, not just
 * attachments) hides the markup entirely. Every emoji reply shipped broken;
 * every ASCII test passed. These tests pin the decoded-form repair.
 */
const gs = loadGs("mime.gs");

const BAD_HTML =
  '<html><body><div dir="auto">\u{1F601} hi</div></body></html>' +
  '<br><div class="gmail_quote"><div class="gmail_attr">On Sat, X wrote:</div>' +
  "<blockquote>quoted \u{1F618}</blockquote></div>";

const GOOD_HTML = '<html><body><div dir="auto">plain and fine</div></body></html>';

/** UTF-8 binary string (one char per byte) for a JS string. */
const toBinary = (s) => {
  const bytes = Buffer.from(s, "utf8");
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
};
const fromBinary = (bin) =>
  Buffer.from([...bin].map((c) => c.charCodeAt(0))).toString("utf8");

const b64 = (s) =>
  Buffer.from(s, "utf8").toString("base64").replace(/(.{76})(?=.)/g, "$1\r\n");

const part = (headers, body) => headers.join("\r\n") + "\r\n\r\n" + body;
const multipart = (...parts) =>
  "\r\n" + parts.map((p) => "--b\r\n" + p).join("\r\n") + "\r\n--b--\r\n";

// ── The two confirmed gaps ───────────────────────────────────────────────────

test("a base64 text/html part with stray closing tags is repaired", () => {
  const raw = multipart(
    part(["Content-Type: text/plain; charset=UTF-8"], "hi"),
    part(
      ["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64"],
      b64(BAD_HTML)
    )
  );

  const out = gs.repairHtmlParts(raw);

  assert.notEqual(out, raw, "the emoji reply case must be repaired, not skipped");
  const b64Body = out.match(/base64\r\n\r\n([\s\S]*?)\r\n--b--/)[1];
  const decoded = fromBinary(gs.base64DecodeBinary(b64Body));
  assert.ok(decoded.endsWith("</body></html>"), "document closes at the end");
  assert.equal(decoded.match(/<\/html/g).length, 1, "exactly one closing html tag");
  assert.ok(decoded.includes("quoted \u{1F618}"), "the quote and its emoji survive");
  assert.ok(decoded.includes("\u{1F601} hi"), "the new content and its emoji survive");
});

test("a quoted-printable part whose closing tag is split by a soft break is repaired", () => {
  const qpBody =
    '<html><body><div dir=3D"auto">hi</div></bo=\r\ndy></ht=\r\nml>' +
    '<br><div class=3D"gmail_quote">quote</div>';
  const raw = multipart(
    part(
      ["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: quoted-printable"],
      qpBody
    )
  );

  const out = gs.repairHtmlParts(raw);

  assert.notEqual(out, raw, "a tag split across a soft break must still be found");
  const qpOut = out.match(/quoted-printable\r\n\r\n([\s\S]*?)\r\n--b--/)[1];
  const decoded = gs.qpDecodeBinary(qpOut);
  assert.ok(decoded.endsWith("</body></html>"), "document closes at the end");
  assert.ok(decoded.includes('class="gmail_quote"'), "the quote block survives");
});

// ── Do no harm ───────────────────────────────────────────────────────────────

test("a well-formed base64 html part ships byte-identical", () => {
  const raw = multipart(
    part(
      ["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64"],
      b64(GOOD_HTML)
    )
  );
  assert.equal(gs.repairHtmlParts(raw), raw, "no gratuitous re-encode");
});

test("a base64 attachment is never decoded or touched", () => {
  const fakePng = b64("\x89PNG not html at all </html> inside binary");
  const raw = multipart(
    part(
      [
        "Content-Type: image/png",
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="x.png"',
      ],
      fakePng
    )
  );
  assert.equal(gs.repairHtmlParts(raw), raw, "attachments pass through untouched");
});

test("a text/plain part is left alone even when it mentions tags", () => {
  const raw = multipart(
    part(["Content-Type: text/plain"], "literally the string </body></html> then more")
  );
  assert.equal(gs.repairHtmlParts(raw), raw);
});

test("a single-part html message uses the outer header for its encoding", () => {
  const outerHeader =
    "MIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n" +
    "Content-Transfer-Encoding: base64\r\n";
  const body = b64(BAD_HTML);

  const out = gs.repairHtmlParts(body, outerHeader);

  assert.notEqual(out, body, "the outer header must route the decode");
  assert.ok(fromBinary(gs.base64DecodeBinary(out)).endsWith("</body></html>"));
});

// ── Codec round-trips ────────────────────────────────────────────────────────

test("base64 codec round-trips emoji bytes exactly", () => {
  const bin = toBinary("emoji \u{1F601}\u{1F618} and text");
  assert.equal(gs.base64DecodeBinary(gs.base64EncodeBinary(bin)), bin);
});

test("base64 encoder wraps at 76 columns", () => {
  const encoded = gs.base64EncodeBinary("x".repeat(300));
  for (const line of encoded.split("\r\n")) assert.ok(line.length <= 76);
});

test("quoted-printable codec round-trips emoji and equals signs", () => {
  const bin = toBinary("a=b \u{1F601} line\r\nnext line ends in space \r\ntail");
  const encoded = gs.qpEncodeBinary(bin);
  assert.equal(gs.qpDecodeBinary(encoded), bin, "decode(encode(x)) === x");
  for (const line of encoded.split("\r\n")) {
    assert.ok(line.length <= 76, `line too long: ${line.length}`);
    assert.ok(!/[ \t]$/.test(line), "no bare trailing whitespace on any line");
  }
});

test("quoted-printable encoder never splits an =XX escape across lines", () => {
  // A long run of emoji forces escapes right up against the wrap point.
  const encoded = gs.qpEncodeBinary(toBinary("\u{1F601}".repeat(60)));
  for (const line of encoded.split("\r\n")) {
    assert.ok(!/=.?$/.test(line) || /=$/.test(line), "only a soft-break '=' may end a line");
    assert.ok(!/=[0-9A-F]?$/.test(line.replace(/=$/, "")), "no half escape at a wrap");
  }
  assert.equal(gs.qpDecodeBinary(encoded), toBinary("\u{1F601}".repeat(60)));
});

test("undecodable base64 in an html part is left alone rather than corrupted", () => {
  const raw = multipart(
    part(
      ["Content-Type: text/html", "Content-Transfer-Encoding: base64"],
      "!!!! not base64 at all ????"
    )
  );
  assert.equal(gs.repairHtmlParts(raw), raw, "do no harm when the decode fails");
});
