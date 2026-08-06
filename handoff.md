# Handoff — 2026-08-06 23:40 CEST

## What this is

`custom-domain-email`: receive mail at your own domains in Gmail via SES →
Lambda → forward, and send as those domains. ~$1/month, all Terraform.
`README.md` explains the system; `docs/relay-premortem.md` is the design story
and the more interesting read — it carries every failure this thing defends
against, including the ones found the hard way.

**This repo is PUBLIC.** Real domains, addresses, and names belong only in
`config/domains.yaml`, `.env`, and Apps Script Script Properties — never in
tracked files. CI blocks AWS keys and tracked private config, but it does
**not** detect real domain names. Grep the diff before committing.

## State: fixed and waiting on a Gmail quota reset

⚠️ **The relay is not sending right now, and will resume on its own.** It ran
out of Apps Script's Gmail quota (20,000 calls/day, consumer account) at about
**21:21 UTC on 6 Aug**, after 314 ticks. The `RelayHeartbeat` metric shows it
exactly — 60 ticks an hour from 15:32 UTC, then nothing:

```bash
aws cloudwatch get-metric-statistics --namespace EmailForwarder \
  --metric-name RelayHeartbeat --period 3600 --statistics Sum --region us-east-1 \
  --start-time "$(date -u -v-30H '+%Y-%m-%dT%H:%M:%SZ')" \
  --end-time "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
```

The old scan read every draft in the mailbox every minute — 30 abandoned drafts
at ~2.1 Gmail calls each is ~64 calls a tick, so the day's allowance was gone in
under six hours. **The quota resets ~24h after the first call of the day, so
roughly 15:30 UTC / 17:30 CEST on 7 Aug**, and the relay starts working again
by itself. Until then, Gmail "Send as" still works — that fallback exists until
January 2027.

**The fix is written, tested, and already pushed to Apps Script** (`clasp push`,
so the live script is the fixed one). A targeted scan now costs ~3 calls a tick
regardless of mailbox size, with a full sweep once an hour as the safety net —
about 6,200 calls a day against 20,000. Branch `relay-gmail-quota`, PR #3, and
pre-mortem item 18 is the full write-up.

**First thing to check after the reset:** the execution log should show
`targeted scan examined 0 draft(s)` most minutes and `full scan examined 30` once
an hour. Then send one real test message — the fixed scan path has never run
against live Gmail, only against unit tests.

## What was verified before all this

Gmail removes "Send as" for third-party addresses in **January 2027**. The Apps
Script relay in `appsscript/` replaces it. **PR #1 is merged to `main`.**

Verified against the bytes SES actually transmitted — recovered from the
inbound S3 copy, not from what the code appeared to produce:

- send via subject token (`>>`) and via the `SES/Outbox` label
- alias inference from a thread, its parent, and the quoted body
- Bcc containment: blind recipients delivered, never disclosed
- reply threading, both directions
- per-domain sender names on the wire (`From: Vibes Queen <hello@…>`)
- failure alerts with stack traces, and the Gmail filter that files them
- IAM scoping: 1 allow, 10 denials, checked against live AWS

Watchdog **armed** — `TF_VAR_relay_enabled=true` lives in `.env`, so a later
`./deploy.sh` cannot silently disarm it. The canary emails if the relay goes
quiet for an hour; confirmed by invoking it and seeing no false alarm.

Test mail and drafts from the build session have been cleared.

## Deploy / ops

```bash
./deploy.sh              # phase 1, non-destructive
./deploy.sh --cutover    # flips MX to SES
```

⚠️ **Always apply with `enable_mx_cutover=true`**, or the MX records are
destroyed. `deploy.sh --cutover` does this; a bare `terraform apply` does not.

```bash
cd lambda && npm test            # 27 tests (run `npm ci` in lambda/src first)
cd appsscript && npm test        # 94 tests
cd appsscript && clasp push -f   # deploy the relay
```

Every alert shares the `[SES alert]` subject prefix; one Gmail filter on
`subject:"SES alert"` catches all of them, from all three runtimes.

Two functions to run from the Apps Script editor when something looks wrong:
`showConfig()` (what the relay actually parsed) and `inspectDrafts()` (what
Gmail actually returned). Both exist because silent fallbacks hid real bugs.

## Open threads

0. **Confirm the relay recovers** after the quota reset (see above), then send
   one real message through it. Highest priority — nothing else matters until
   outbound works again.
1. **Untested: attachments.** Send a reply with a photo; confirm it arrives
   intact and appears in the Sent copy. SES caps a send at 10 MB.
2. **CI never ran on the final commits** — GitHub's runners were backlogged for
   hours. Everything was verified locally instead (both suites, terraform fmt
   and validate, the same secret guards CI runs) and that is recorded in the
   merge commit. Worth a glance at the Actions tab once it drains.
3. **Git history still holds a real domain and name** from the test fixture in
   `c87e925`. Scrubbing needs a force-push, which rewrites hashes for anyone who
   cloned or forked. Zero forks, so the cost is unusually low right now.
4. **SPF deserves its own PR.** One domain publishes SPF without
   `include:amazonses.com`, three publish none, so outbound rests entirely on
   DKIM alignment — which passes on all four, but with no margin. That domain
   has a live third-party sender, so change it alone and test independently.

## Time-sensitive

- **January 2027** — Gmail "Send as" for third-party addresses is removed. The
  relay must be working before then. It is; keep it that way.
- **Now–Q4 2026** — the window where both paths work, and the only time the
  relay can be compared against a known-good reference. Worth doing before the
  fallback disappears.

## Gotchas that cost real time (all written up in the pre-mortem)

- **A per-minute trigger gets ~13 Gmail calls a tick, and no more.** 20,000/day
  ÷ 1,440 ticks. Anything the scan does per draft is multiplied by the size of
  the mailbox *and* by 1,440 — cost it per day before adding it. Correct and
  affordable are separate reviews; only the first one was done.
- **An alert on a repeating condition needs a throttle.** The run-failure email
  fired on every tick, so one stuck relay also burned the separate
  100-recipients-a-day quota that the real per-draft alerts need.

- **SES's `FromEmailAddress` overrides the raw message's `From` header.** Pass
  the fully formatted value or the display name is silently discarded.
- **An optimisation that skips a write must compare against the last write, not
  the last read.** Comparing to the load-time value stranded in-flight records
  and reported every successful send as possibly-unsent.
- **Only `STATE_BUCKETS` survive a state reload.** Any other key set on the
  state object is dropped silently, so a "run once" flag stored there fires
  every minute forever.
- Apps Script advanced services return `bytes` fields as **Byte[]**, already
  decoded — not the base64 string the REST API documents.
- `clasp create-script` **overwrites `src/appsscript.json`**, dropping the
  advanced-service and scope declarations. Restore from git before pushing.
- Changing the manifest requires **re-authorisation**: run any function from the
  editor, or the installed trigger keeps failing under the old grant.
- The Apps Script editor **caches its file list** — reload the tab after a push
  or new functions never appear in the Run dropdown.
- Gmail's stored draft closes `</body></html>` **before** the quoted reply.
  Gmail's own sender repairs this; the relay must too, or recipients see an
  apparently empty message.
- Gmail does not always thread a reply with its parent, and may record no
  `In-Reply-To` at all — hence six ordered layers of alias inference.

## Debugging posture

Four separate bugs each cost multiple rounds because the failure was theorised
about rather than instrumented, and every one collapsed within minutes of making
the code report what it actually saw. Two of them lived in a *seam* — the SES
call, and the state write — while every individual component verified correct.

**When each component checks out but the output is wrong, probe the seam, and
probe it before forming a third theory.**
