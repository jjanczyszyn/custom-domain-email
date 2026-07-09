import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const ses = new SESClient({});
const FROM = process.env.FROM_ADDRESS; // no-reply@<domain>, a verified identity
const ALERT_EMAIL = process.env.ALERT_EMAIL; // operator inbox
const BUCKET = process.env.S3_BUCKET;
const PREFIX = process.env.S3_PREFIX || "";

// Pull a header value out of the SES event's parsed headers array.
function header(mail, name) {
  const lower = name.toLowerCase();
  const h = (mail.headers || []).find((x) => x.name.toLowerCase() === lower);
  if (h) return h.value;
  return (mail.commonHeaders || {})[lower] || "";
}

// Triggered by the forwarder's dead-letter queue. Any inbound email that could
// not be forwarded after retries lands here as an async-invocation failure
// record. Instead of a CloudWatch alarm, we email a plain summary so the failed
// message still shows up in the inbox (in limited form) and signals that the
// pipeline needs a poke. One SQS record = one notice.
export const handler = async (event) => {
  for (const record of event.Records) {
    let body;
    try {
      body = JSON.parse(record.body);
    } catch {
      body = {};
    }

    const sesEvent = body?.requestPayload?.Records?.[0]?.ses;
    const mail = sesEvent?.mail || {};
    const recipients = sesEvent?.receipt?.recipients || mail.destination || [];
    const messageId = mail.messageId || "(unknown)";
    const from = header(mail, "from") || mail.source || "(unknown sender)";
    const subject = header(mail, "subject") || "(no subject)";
    const date = header(mail, "date") || mail.timestamp || "";
    const reason =
      body?.responsePayload?.errorMessage ||
      body?.requestContext?.condition ||
      "unknown error";
    const key = `${PREFIX}${messageId}`;

    const text = [
      "An inbound email could not be delivered to your inbox and needs attention.",
      "",
      `  From:     ${from}`,
      `  To:       ${recipients.join(", ")}`,
      `  Subject:  ${subject}`,
      date ? `  Date:     ${date}` : null,
      "",
      `  Why it failed: ${reason}`,
      "",
      "The full original is still in S3 — fetch it, then open in any mail client:",
      "",
      `  aws s3 cp s3://${BUCKET}/${key} ./email.eml`,
      "",
      "The forwarding pipeline needs a fix. Once it's patched, re-send that file",
      "through SES (or re-run the forwarder) to deliver the message.",
    ]
      .filter((l) => l !== null)
      .join("\n");

    await ses.send(
      new SendEmailCommand({
        Source: FROM,
        Destination: { ToAddresses: [ALERT_EMAIL] },
        Message: {
          Subject: { Data: `[Delivery failed — poke the pipeline] ${subject}` },
          Body: { Text: { Data: text } },
        },
      })
    );
    console.log(`Failure notice emailed for ${messageId} (${reason}) -> ${ALERT_EMAIL}`);
  }

  return { notified: event.Records.length };
};
