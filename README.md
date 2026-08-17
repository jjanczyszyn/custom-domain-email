# custom-domain-email

Receive email at your own domains in Gmail, and reply as those domains, for about
a dollar a month. No Google Workspace, no paid forwarding service. It runs on your
own AWS account (SES + Lambda + S3 + Route53) and is managed with Terraform.

Inbound mail to `*@yourdomain` is received by SES, stored in S3, and a Lambda
re-sends it to your Gmail (the original sender is kept in `Reply-To`). Outbound
uses SES SMTP wired into Gmail's "Send mail as".

![How the email setup works](docs/email-setup-diagram.png)

## What it costs

Around **$1/month** at personal volume, almost all of which is the optional
monitoring (4 CloudWatch alarms + a handful of custom metrics — the heartbeat,
plus one `RelayFault` series per *kind* of failure seen in the last week, which
is normally none). Mail receiving, sending,
Lambda, S3, and the dead-letter SQS queue sit inside free tiers. Route53 hosted
zones are billed separately at $0.50/zone whether or not you run this.

## Requirements

- An AWS account.
- Your domains' DNS in **Route53** (in that same account).
- Terraform and the AWS CLI installed and authenticated.

## Setup

```bash
cp config/domains.example.yaml config/domains.yaml   # your domains + where they forward
cp .env.example .env                                 # your alarm email

./deploy.sh             # Phase 1: stand everything up (MX NOT switched yet)
./status.sh             # watch until domains + destinations are verified
./deploy.sh --cutover   # Phase 2: flip inbound MX to SES
```

`config/domains.yaml` and `.env` are gitignored, so your addresses never get
committed.

The rollout is two-phase on purpose: Phase 1 is non-destructive (any existing
inbound keeps working), and you only switch MX once SES has verified everything,
so no mail is lost in the gap. Between the phases:

1. **Verify destinations.** SES emails a link to each `forward_to` address. Click
   it. This is required while the SES account is in the sandbox.
2. **Wait for verification.** `./status.sh` should show every domain and
   destination verified before you cut over.

After cutover:

3. **Test.** Email an address on one of your domains. It should land in Gmail.
4. **Reply as your domain.** In Gmail: Settings > Accounts and Import >
   "Send mail as" > add `hello@yourdomain`, with:
   ```
   SMTP server: email-smtp.<region>.amazonaws.com   (terraform output smtp_endpoint)
   Port:        465 (SSL)
   Username:    terraform output -raw smtp_username
   Password:    terraform output -raw smtp_password
   ```
   One credential set works for every domain. Gmail emails a confirmation code to
   `hello@yourdomain`, which now forwards into your inbox.

   > **Gmail removes "Send as" for third-party addresses in January 2027**, and
   > will restrict *new* configurations before then. Set this up now if you
   > still can — it works until the deadline — but the durable replacement is
   > the outbound relay below. Inbound forwarding is explicitly unaffected by
   > that change.

5. **Leave the sandbox** (optional, free) to reply to anyone, not just verified
   addresses: request production access in the SES console.

## Show your photo next to outgoing mail (optional, free)

Gmail shows the sender's Google profile photo. A "Send mail as" alias has none, so
give the address its own free Google profile:

1. In a signed-out browser, go to accounts.google.com > Create account >
   "For my personal use".
2. On the username screen, click **"Use your existing email"** and enter
   `hello@yourdomain`.
3. Enter the verification code Google sends (it forwards into your inbox).
4. Set the profile photo. Recipients now see it next to your emails.

## Sending after January 2027

Gmail is removing "Send as" for third-party addresses in January 2027. That
kills the outbound half of this project — the inbound half is untouched, and
Google confirms that forwarding into Gmail is unaffected.

[`appsscript/`](appsscript/) is the replacement, and it keeps composing in
Gmail. Write a draft as normal, mark it with the `SES/Outbox` label or a `>>`
subject prefix, and a one-minute Apps Script trigger relays it through SES as
one of your domains, then files the copy in Sent with the same Message-ID so
replies keep threading. Works on web and mobile; costs nothing extra.

Setup is in [`appsscript/README.md`](appsscript/README.md). The design, and the
failure cases it is built around, are in
[`docs/relay-premortem.md`](docs/relay-premortem.md).

Both paths work until the deadline, so run them side by side and compare before
Send-As disappears.

## How it works

```
mail -> Route53 MX -> SES receipt rule -> S3 (raw) ┐
                                                    ├─> Lambda -> SES SendRawEmail -> Gmail
                                             invoke ┘
reply <- Gmail "Send mail as" <- SES SMTP <───────────────────────────────────────────────┘
   or <- Apps Script relay ---- SES API <──────────────────────────────────────────────────┘
```

- **`main.tf`** loads `config/domains.yaml` and builds the routing map.
- **`shared.tf`** S3 bucket, forwarder Lambda, SES rule set, SMTP user, log groups.
- **`modules/domain/`** per-domain SES identity, DKIM, MX, receipt rule.
- **`monitoring.tf`** SNS alerts, alarms, heartbeat canary.
- **`lambda/src/`** forwarder runtime (`lib.mjs` pure logic, `index.mjs` handler).
- **`lambda/test/`** unit tests. **`canary/`** heartbeat sender.
- **`appsscript/`** the outbound relay that replaces Gmail "Send as".

## Tests

The routing and header-rewrite logic lives in `lambda/src/lib.mjs` and is covered
by `lambda/test/lib.test.mjs` (Node's built-in runner, no dependencies):

```bash
cd lambda && npm test
```

To change behaviour, add or adjust a case, watch it fail, then edit `lib.mjs`
until it passes. The handler stays a thin I/O shell over the tested functions.

## Monitoring

There are deliberately **no CloudWatch alarms**. Every failure instead arrives as
a plain email to `alert_email`, so mail always shows up in some form and you know
to poke the pipeline for a fix:

- **Dead-lettered forwards → an email.** SES invokes the forwarder
  asynchronously, so any invocation that still throws after its retries is routed
  to an SQS dead-letter queue (`*-forwarder-dlq`) instead of vanishing. The
  `*-notifier` Lambda consumes that queue and emails you a summary — who it was
  from, the subject, why it failed, and the `aws s3 cp` command to fetch the full
  original (still in S3). A delivery failure is always surfaced, never silent.
- **Silent pipeline → an email.** A canary emails `probe@<first-domain>` hourly
  through the real path; the forwarder records a `CanaryHeartbeat` metric on
  arrival. On each run the canary first checks that recent probes were recorded —
  if none were, the whole inbound path is down (MX changed, receipt rule
  disabled, forwarder broken) and no in-pipeline email could ever fire, so the
  canary emails you directly. This is the one failure the DLQ notifier can't
  catch, because nothing reaches the forwarder to dead-letter.
- **A failed relay run → an email only when mail is waiting on it.** The relay
  retries every minute, so a tick that dies with nothing marked has already
  fixed itself by the time you could read about it. Those are recorded instead:
  in a `journal` inside the relay's state (`showFaults()` prints it — message,
  count, first and last sighting, whether it was ever emailed) and as the
  `RelayFault` CloudWatch metric, dimensioned by a slug of the message so it can
  be read without opening the Apps Script editor:

  ```bash
  aws cloudwatch list-metrics --namespace EmailForwarder --metric-name RelayFault
  aws cloudwatch get-metric-statistics --namespace EmailForwarder \
    --metric-name RelayFault --period 3600 --statistics Sum --region us-east-1 \
    --start-time "$(date -u -v-24H '+%Y-%m-%dT%H:%M:%SZ')" \
    --end-time "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  ```

  You are emailed when a send is unaccounted for, when a draft the relay had
  already picked up as marked is still sitting there, when the Gmail daily quota
  goes (an outage measured in hours), or when the relay has been failing long
  enough that it can no longer see drafts you mark — half an hour for a refusal
  Gmail is known to retract, ten minutes for anything else. See
  `docs/relay-premortem.md` item 19.

### Filing the alerts in Gmail

Every alert — from the DLQ notifier, the canary watchdog, or the relay — has a
subject starting `[SES alert]`. One Gmail filter catches all of them. Search
options → **Has the words**:

```
subject:"SES alert"
```

They arrive over two independent channels: the Lambdas send through SES, and
the relay sends through Apps Script's `MailApp`. That is deliberate — the relay
cannot rely on SES to tell you SES is broken — and it is why they share a
subject prefix rather than a sender.

The prefix is declared in three places (`appsscript/src/config.gs`,
`notifier/index.mjs`, `canary/index.mjs`) because those are separate runtimes
sharing no code. `appsscript/test/alert-prefix.test.mjs` fails if they drift,
since a stale prefix would silently stop alerts being filed.

Note that Gmail strips the brackets when searching, so the filter matches the
phrase "SES alert" rather than the literal `[SES alert]`. The brackets are for
your eye in the inbox.

Apply a label (e.g. `SES/Alerts`) and tick **Never send it to Spam** — alerts
arrive from your own domain, which is exactly the shape spam filters distrust.
Do *not* have them skip the inbox; the whole point is that you see them.

### Oversize mail

SES *receives* up to 40 MB but `SendRawEmail` only *sends* up to 10 MB, so a
message in that gap can't be forwarded whole. Instead of failing (and dropping
it), the forwarder:

1. **Recompresses images to fit.** Most oversize mail is photos. It re-encodes
   the images (largest first, highest quality that still fits) until the message
   is under 10 MB and forwards it as a normal email — inline photos intact, just
   at lower resolution. This handles the common case transparently.
2. **Falls back to an archive notice** when images alone can't get under the
   limit (e.g. a large video). The original is copied to the `archive/` prefix
   (which the lifecycle rule never expires) and you get a small notice with the
   sender, subject, size, and the `aws s3 cp` command to pull the full original.

Either way a large email is never silently dropped. (An earlier design served the
fallback as a one-click Lambda Function URL link, but this AWS account blocks
public function URLs, so the private S3 archive is the durable path instead.)

## Notes

- Setting the SES MX overwrites any existing MX on the domain (the `--cutover`
  step). Existing inbound forwarding is replaced.
- Custom MAIL FROM is off by default, so a domain already sending via SES or
  Resend keeps working untouched.
- Region defaults to `us-east-1` because SES inbound is region-limited
  (us-east-1, us-west-2, eu-west-1).
- Raw emails auto-delete from S3 after 30 days.
- **This repo is public.** Your domains and addresses live in `config/domains.yaml`
  and `.env`, both gitignored, and CI fails the build if either becomes tracked
  or if an AWS key appears in a tracked file. Test fixtures use RFC 2606 reserved
  example domains. One caveat: a real domain and name were committed in a test
  fixture in `c87e925` and are still reachable in git history — the working tree
  is clean, but scrubbing history needs a force-push, which rewrites hashes for
  anyone who has cloned or forked.
