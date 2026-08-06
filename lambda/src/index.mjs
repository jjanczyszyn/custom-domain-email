import { S3Client, GetObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import {
  resolve,
  rewrite,
  isProbe,
  isOversize,
  oversizeNotice,
  wrapAsAttachment,
  FORWARD_TARGET_BYTES,
} from "./lib.mjs";
import { shrinkToFit } from "./shrink.mjs";

const s3 = new S3Client({});
const ses = new SESClient({});
const cw = new CloudWatchClient({});

const MAPPING = JSON.parse(process.env.MAPPING_JSON || "{}");
const FROM_LOCALPART = process.env.FROM_LOCALPART || "no-reply";
const PROBE_LOCALPART = process.env.PROBE_LOCALPART || "probe";
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE || "EmailForwarder";
const BUCKET = process.env.S3_BUCKET;
const PREFIX = process.env.S3_PREFIX || "";

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

async function putMetric(name) {
  await cw.send(
    new PutMetricDataCommand({
      Namespace: METRIC_NAMESPACE,
      MetricData: [{ MetricName: name, Value: 1, Unit: "Count" }],
    })
  );
}

const sendRaw = (fromAddress, destinations, data) =>
  ses.send(
    new SendRawEmailCommand({
      Source: fromAddress,
      Destinations: destinations,
      RawMessage: { Data: data },
    })
  );

// SES rejects a message for *content* reasons (a header it can't parse, a
// rejected address) with these codes — the failures our fallback can recover.
// Everything else (throttling, credentials, S3) is transient/infrastructure:
// let it throw so the async retry + DLQ + alarm still cover it.
const CONTENT_ERROR_CODES = ["InvalidParameterValue", "MessageRejected", "InvalidParameterCombination"];
const isSendContentError = (err) => CONTENT_ERROR_CODES.includes(err?.name);

// Durable fallback shared by the oversize and rejected-send paths: keep a
// permanent copy of the original (the archive/ prefix is exempt from the
// inbound lifecycle rule) and send a small notice pointing at it, so the mail
// is recoverable even when it can't be delivered whole.
async function archiveAndNotify({ key, messageId, size, raw, destinations, fromAddress }) {
  const archiveKey = `archive/${messageId}`;
  await s3.send(
    new CopyObjectCommand({ Bucket: BUCKET, CopySource: `${BUCKET}/${key}`, Key: archiveKey })
  );
  const notice = oversizeNotice({
    headerRaw: raw.subarray(0, 65536).toString("utf-8"),
    fromAddress,
    destinations,
    bucket: BUCKET,
    key: archiveKey,
    sizeBytes: size,
  });
  await sendRaw(fromAddress, destinations, Buffer.from(notice));
  return archiveKey;
}

// A message too large for SES SendRawEmail (10 MiB). First try recompressing its
// images to fit and forward it as a real email; if that is not enough (e.g. a
// large video), archive the original to a permanent prefix and forward a notice
// carrying a durable download link. Either way the mail is never dropped.
async function forwardOversize({ key, messageId, size, raw, destinations, fromAddress, recipients }) {
  let shrunk = null;
  try {
    shrunk = await shrinkToFit(raw, { fromAddress, destinations, targetBytes: FORWARD_TARGET_BYTES });
  } catch (err) {
    console.error(`Recompress error for ${messageId}: ${err.name} ${err.message}`);
  }

  if (shrunk) {
    await sendRaw(fromAddress, destinations, shrunk.message);
    await putMetric("OversizeRecompressed");
    console.log(
      `Oversize ${messageId} recompressed ${size}->${shrunk.newBytes} bytes (tier ${JSON.stringify(shrunk.tier)}); forwarded -> ${destinations.join(", ")}`
    );
    return;
  }

  // Couldn't shrink enough — keep a permanent copy and point a notice at it.
  await archiveAndNotify({ key, messageId, size, raw, destinations, fromAddress });
  await putMetric("OversizeLinked");
  console.log(
    `Oversize ${messageId} (${size} bytes) too big to recompress; archived + linked -> ${destinations.join(", ")}`
  );
}

// Forward a normal-size message, guaranteeing it is never dropped. The
// rewritten raw is tried first (the common path). If SES rejects it for a
// content reason — a malformed inherited header it still won't accept even
// after sanitizing — fall back to re-sending the untouched original as an
// attachment in an envelope we fully control, and finally to the durable
// archive+notice. A bad header downgrades HOW the mail arrives, never WHETHER.
async function forwardNormal({ key, messageId, size, raw, destinations, fromAddress, recipients }) {
  try {
    await sendRaw(fromAddress, destinations, Buffer.from(rewrite(raw.toString("utf-8"), fromAddress)));
    console.log(
      `Forwarded ${messageId} (${size} bytes, ${recipients.join(", ")}) -> ${destinations.join(", ")}`
    );
    return;
  } catch (err) {
    if (!isSendContentError(err)) throw err; // transient/infra -> retry + DLQ
    console.error(
      `Direct forward rejected for ${messageId}: ${err.name} ${err.message}; trying attachment fallback`
    );
  }

  // Fallback 1: original as a message/rfc822 attachment (base64 inflates ~33%,
  // so only when it still fits under the SES limit).
  const wrapped = wrapAsAttachment(raw, { fromAddress, destinations });
  if (wrapped.length <= FORWARD_TARGET_BYTES) {
    try {
      await sendRaw(fromAddress, destinations, wrapped);
      await putMetric("ForwardFallbackAttached");
      console.log(`Forwarded ${messageId} as attachment fallback -> ${destinations.join(", ")}`);
      return;
    } catch (err) {
      console.error(`Attachment fallback failed for ${messageId}: ${err.name} ${err.message}; archiving`);
    }
  }

  // Fallback 2: archive the original + send a retrieval notice.
  await archiveAndNotify({ key, messageId, size, raw, destinations, fromAddress });
  await putMetric("ForwardFallbackArchived");
  console.log(`Forward ${messageId} archived + notified (could not send inline) -> ${destinations.join(", ")}`);
}

export const handler = async (event) => {
  const record = event.Records[0].ses;
  const messageId = record.mail.messageId;
  const recipients = record.receipt.recipients || [];

  // Heartbeat probe: record liveness and stop (do not forward to a person).
  if (isProbe(recipients, PROBE_LOCALPART)) {
    await putMetric("CanaryHeartbeat");
    console.log(`Heartbeat probe received for ${recipients.join(", ")}`);
    return { disposition: "STOP_RULE" };
  }

  const { destinations, fromDomain } = resolve(recipients, MAPPING);
  if (destinations.length === 0) {
    console.log(`No mapping for ${recipients.join(", ")}; dropping.`);
    return { disposition: "STOP_RULE" };
  }

  const fromAddress = `${FROM_LOCALPART}@${fromDomain}`;
  const key = `${PREFIX}${messageId}`;

  // Re-throwing keeps the Errors alarm + DLQ working, but log which message and
  // recipients failed first — the SES/SDK error alone does not say.
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const raw = await streamToBuffer(obj.Body);
    const size = raw.length;

    if (isOversize(size)) {
      await forwardOversize({ key, messageId, size, raw, destinations, fromAddress, recipients });
      return { disposition: "CONTINUE" };
    }

    await forwardNormal({ key, messageId, size, raw, destinations, fromAddress, recipients });
    return { disposition: "CONTINUE" };
  } catch (err) {
    console.error(
      `Forward FAILED for ${messageId} (${recipients.join(", ")} -> ${destinations.join(", ")}): ${err.name} ${err.message}`
    );
    throw err;
  }
};
