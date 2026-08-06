# Outbound relay (Gmail → SES)

Gmail removes "Send as" for third-party addresses in **January 2027**, which is
how this project has sent mail as your own domains. Inbound is unaffected —
plain forwarding into Gmail keeps working, and Google says so explicitly. Only
the outbound half needs replacing.

This is that replacement. You write a draft in Gmail exactly as you do now, mark
it, and an Apps Script trigger relays it through SES as one of your domains,
then files a copy in Sent. Composing stays in Gmail, on web and on mobile.

## How it works

```
draft in Gmail ──mark──> trigger (1/min) ──> SES SendEmail ──> recipient
                                │
                                └──> Gmail messages.insert ──> your Sent folder
```

The design and every failure it defends against are written up in
[`docs/relay-premortem.md`](../docs/relay-premortem.md). Read that before
changing anything here — the ordering inside `processDraft()` in particular is
load-bearing, and the reasoning is not obvious from the code alone.

## Marking a draft

Either marker sends. Use whichever suits where you are:

| Marker | Where it works | Example |
|---|---|---|
| Label `SES/Outbox` | Gmail on the web | apply the label to the draft |
| Subject prefix `>>` | anywhere, including mobile compose | `>>Thanks for today` |

Which domain it goes out as, in priority order:

1. **The subject token**, when it names a domain — `>>example.net Subject here`,
   or a full address, `>>bookings@example.net Subject here`.
2. **A `SES/from:<domain>` label** on the draft.
3. **Inferred from the thread** — a reply goes out as the address the thread was
   originally delivered to, matching Gmail's "reply from the same address"
   behaviour. This covers nearly every reply, so in practice you just mark and go.

If none of those resolve, the relay **refuses to send** and emails you. It will
not guess a default: a message that doesn't go out is recoverable, one sent from
the wrong domain is not.

There is roughly a one-minute delay between marking and sending, which is the
Apps Script trigger floor. That delay is also your undo window — remove the
marker within it and nothing goes out.

## Files

| File | What it does | Tested |
|---|---|---|
| `src/mime.gs` | header rewriting, Bcc containment, alias selection, size checks | ✅ `test/mime.test.mjs` |
| `src/sigv4.gs` | AWS request signing | ✅ `test/sigv4.test.mjs` (AWS vectors) |
| `src/aws.gs` | SES send + CloudWatch heartbeat (I/O shell) | — |
| `src/relay.gs` | the trigger, draft scanning, send ordering | — |
| `src/config.gs` | Script Properties, validated | — |
| `src/setup.gs` | installer and manual checks | — |

Same split as `lambda/`: the logic that can be wrong in a subtle way is pure and
tested under Node; the I/O shells stay thin.

```bash
cd appsscript && npm test
```

## Install

**1. Create the AWS credentials.** They are provisioned by Terraform as a
dedicated, minimally-scoped IAM user — it can send as your verified domains and
publish one metric, nothing else.

```bash
terraform apply
terraform output relay_access_key_id
terraform output -raw relay_secret_access_key
```

**2. Create the Apps Script project.** Use
[clasp](https://github.com/google/clasp), Google's CLI — you will be editing
this code while testing, and re-pushing beats re-pasting six files:

```bash
npm install -g @google/clasp
clasp login                                    # opens a browser
cd appsscript
clasp create-script --type standalone --title "Domain mail relay" --rootDir src
clasp push
clasp open-script
```

Command names differ across clasp majors — these are for clasp 3.x, where
`create` and `open` became `create-script` and `open-script`. `clasp --help`
lists what your version accepts.

`clasp create` writes `.clasp.json` with your script ID. It is gitignored —
`.clasp.json.example` shows the shape. After any local edit, `clasp push`.

<details>
<summary>Without clasp</summary>

Create a project at [script.google.com](https://script.google.com), then copy
in each file from `src/` as a `.gs` file of the same name, plus `appsscript.json`
via Project Settings → *Show "appsscript.json" manifest file in editor*.
</details>

**3. Fill in Script Properties** (Project Settings → Script Properties). These
are the only place credentials live — nothing secret is committed to this repo.

| Property | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | from step 1 |
| `AWS_SECRET_ACCESS_KEY` | from step 1 |
| `AWS_REGION` | `us-east-1` (must match your SES region) |
| `DOMAINS` | comma-separated, e.g. `example.com,example.net` |
| `DEFAULT_LOCALPART` | `hello` — used when a domain is named without a local part |
| `ALERT_EMAIL` | where failure emails go |
| `METRIC_NAMESPACE` | `EmailForwarder`, matching `var.metric_namespace` |
| `SETTLE_SECONDS` | optional, default `45` |
| `STALE_MINUTES` | optional, default `15` |

**4. Run `setUp()`** from the editor. It creates the labels, installs the
one-minute trigger, and tells you what it configured. Google will ask you to
authorise the scopes in `appsscript.json` — Gmail access, outbound HTTP to AWS,
and trigger management.

**5. Verify, in order.** Each step isolates a different failure:

```
checkAws()        # credentials + signing only — no mail sent
sendTestEmail()   # a real send through SES to your alert address
```

Then send a real one: reply to a message in your inbox, mark it, wait a minute.
Check that it arrived, that it threaded correctly for the recipient, and that
the copy in your Sent folder sits in the right conversation.

**6. Turn on the watchdog.** Once the relay is genuinely running:

```bash
terraform apply -var relay_enabled=true
```

The canary Lambda then emails you if the relay ever goes quiet for an hour. Do
this *last* — enabling it before the relay is installed just generates alerts
about a relay that was never there.

## Run it alongside Send-As while you can

Until January 2027 both paths work. Send the same message both ways and compare
what lands: the From line, the threading, the Sent copy, attachments. That
comparison is only available while Send-As still exists, so it is worth doing
now rather than discovering a discrepancy in January with no reference to
check against.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing sends, no email | The trigger isn't installed. Run `setUp()`, then check Triggers in the editor. |
| `403` from `checkAws()` | Wrong key, wrong region, or the key was rotated by a later `terraform apply`. |
| "Could not tell which domain to send as" | New message with no domain named — use `>>domain Subject` or a `SES/from:` label. |
| Draft labelled `SES/Needs-Review` | A send was interrupted mid-flight. Check Sent before re-marking; it was deliberately not retried. |
| Draft labelled `SES/Failed` | The send failed cleanly. The email tells you why; the draft is untouched. |
