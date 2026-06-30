import { S3Client, GetObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { resolve, rewrite, isProbe, isOversize, oversizeNotice, FORWARD_TARGET_BYTES } from "./lib.mjs";
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

  // Couldn't shrink enough — keep a permanent copy (the archive/ prefix is not
  // covered by the inbound lifecycle rule) and point the notice at it.
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
  await putMetric("OversizeLinked");
  console.log(
    `Oversize ${messageId} (${size} bytes) too big to recompress; archived + linked -> ${destinations.join(", ")}`
  );
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

    await sendRaw(fromAddress, destinations, Buffer.from(rewrite(raw.toString("utf-8"), fromAddress)));

    console.log(
      `Forwarded ${messageId} (${size} bytes, ${recipients.join(", ")}) -> ${destinations.join(", ")}`
    );
    return { disposition: "CONTINUE" };
  } catch (err) {
    console.error(
      `Forward FAILED for ${messageId} (${recipients.join(", ")} -> ${destinations.join(", ")}): ${err.name} ${err.message}`
    );
    throw err;
  }
};
