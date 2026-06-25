import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const ses = new SESClient({});
const FROM = process.env.FROM_ADDRESS;
const PROBE = process.env.PROBE_ADDRESS;

// Scheduled heartbeat: send a probe through the real inbound path
// (SES send -> MX -> receipt rule -> forwarder Lambda). The forwarder records a
// CloudWatch metric when it arrives; an alarm fires if that metric goes missing,
// catching silent outages (MX changed, rule disabled, Lambda broken).
export const handler = async () => {
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
