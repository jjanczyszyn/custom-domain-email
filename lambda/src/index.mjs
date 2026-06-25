import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { resolve, rewrite, isProbe } from "./lib.mjs";

const s3 = new S3Client({});
const ses = new SESClient({});
const cw = new CloudWatchClient({});

const MAPPING = JSON.parse(process.env.MAPPING_JSON || "{}");
const FROM_LOCALPART = process.env.FROM_LOCALPART || "no-reply";
const PROBE_LOCALPART = process.env.PROBE_LOCALPART || "probe";
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE || "EmailForwarder";
const BUCKET = process.env.S3_BUCKET;
const PREFIX = process.env.S3_PREFIX || "";

const streamToString = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
};

async function heartbeat() {
  await cw.send(
    new PutMetricDataCommand({
      Namespace: METRIC_NAMESPACE,
      MetricData: [{ MetricName: "CanaryHeartbeat", Value: 1, Unit: "Count" }],
    })
  );
}

export const handler = async (event) => {
  const record = event.Records[0].ses;
  const messageId = record.mail.messageId;
  const recipients = record.receipt.recipients || [];

  // Heartbeat probe: record liveness and stop (do not forward to a person).
  if (isProbe(recipients, PROBE_LOCALPART)) {
    await heartbeat();
    console.log(`Heartbeat probe received for ${recipients.join(", ")}`);
    return { disposition: "STOP_RULE" };
  }

  const { destinations, fromDomain } = resolve(recipients, MAPPING);
  if (destinations.length === 0) {
    console.log(`No mapping for ${recipients.join(", ")}; dropping.`);
    return { disposition: "STOP_RULE" };
  }

  const fromAddress = `${FROM_LOCALPART}@${fromDomain}`;
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}${messageId}` }));
  const raw = await streamToString(obj.Body);

  await ses.send(
    new SendRawEmailCommand({
      Source: fromAddress,
      Destinations: destinations,
      RawMessage: { Data: Buffer.from(rewrite(raw, fromAddress)) },
    })
  );

  console.log(`Forwarded ${messageId} (${recipients.join(", ")}) -> ${destinations.join(", ")}`);
  return { disposition: "CONTINUE" };
};
