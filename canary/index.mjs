import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";

const ses = new SESClient({});
const cw = new CloudWatchClient({});
const FROM = process.env.FROM_ADDRESS;
const PROBE = process.env.PROBE_ADDRESS;
const ALERT_EMAIL = process.env.ALERT_EMAIL;
const NAMESPACE = process.env.METRIC_NAMESPACE || "EmailForwarder";
const WINDOW_SECONDS = parseInt(process.env.HEARTBEAT_WINDOW_SECONDS || "7200", 10);

// How many CanaryHeartbeat points the forwarder recorded within the window.
// The forwarder emits this metric when a probe reaches it through the real
// inbound path, so a zero means that path is broken.
async function heartbeatsInWindow() {
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_SECONDS * 1000);
  const res = await cw.send(
    new GetMetricStatisticsCommand({
      Namespace: NAMESPACE,
      MetricName: "CanaryHeartbeat",
      StartTime: start,
      EndTime: end,
      Period: Math.max(60, WINDOW_SECONDS),
      Statistics: ["Sum"],
    })
  );
  return (res.Datapoints || []).reduce((n, d) => n + (d.Sum || 0), 0);
}

async function emailAlert(subject, text) {
  await ses.send(
    new SendEmailCommand({
      Source: FROM,
      Destination: { ToAddresses: [ALERT_EMAIL] },
      Message: { Subject: { Data: subject }, Body: { Text: { Data: text } } },
    })
  );
}

// Scheduled watchdog + heartbeat. First it checks whether earlier probes were
// recorded within the window; if none were, the inbound pipeline has gone
// silent (MX changed, receipt rule disabled, forwarder down) and NO failure
// email can be generated from inside it — so we email the operator directly.
// Then it sends a fresh probe through the real path to feed the next check.
export const handler = async () => {
  try {
    const count = await heartbeatsInWindow();
    if (count === 0) {
      const hrs = (WINDOW_SECONDS / 3600).toFixed(1);
      await emailAlert("[Email pipeline silent — poke the pipeline]", [
        `No inbound-pipeline heartbeat has been recorded in the last ${hrs} hours.`,
        "",
        "Probe mail is not making it through SES -> receipt rule -> forwarder,",
        "so real inbound mail is probably being lost at the source. Likely causes:",
        "the MX record changed, the SES receipt rule was disabled, or the",
        "forwarder Lambda is broken. Check the pipeline and fix it.",
      ].join("\n"));
      console.log(`Silent-pipeline alert emailed -> ${ALERT_EMAIL}`);
    }
  } catch (err) {
    // A check failure must never stop the probe from going out.
    console.error(`Heartbeat check failed: ${err.name} ${err.message}`);
  }

  const stamp = new Date().toISOString();
  await ses.send(
    new SendEmailCommand({
      Source: FROM,
      Destination: { ToAddresses: [PROBE] },
      Message: {
        Subject: { Data: `heartbeat ${stamp}` },
        Body: { Text: { Data: `Automated pipeline heartbeat sent at ${stamp}.` } },
      },
    })
  );
  console.log(`Heartbeat sent ${FROM} -> ${PROBE} at ${stamp}`);
  return { sent: true, stamp };
};
