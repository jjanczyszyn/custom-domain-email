# Handoff — 2026-08-07 00:05 CEST

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

## State: relay running, fix deployed, PR #3 open and unmerged

The relay went live 6 Aug and **exhausted Apps Script's Gmail quota** (20,000
calls/day) about six hours later. It did not stop dead — it began missing ticks
as it hit the ceiling, and `GmailApp.getDrafts()` threw on the ones that failed.
Cause: the scan read *every* draft in the mailbox every minute, ~2.1 Gmail calls
each, and there were 30 abandoned drafts. Pre-mortem item 18 is the write-up.

Fixed on branch `relay-gmail-quota` (**PR #3**), and **already `clasp push`ed —
the live script is the fixed one.** A targeted scan now costs ~3 calls a tick
regardless of mailbox size, with a full hourly sweep as the safety net. With the
drafts cleared that is ~4,000 calls a day against 20,000.

The heartbeat resumed within minutes of the deploy — 14 of the last 20 minutes
at 22:00 UTC, still recovering because the day's allowance was spent before the
fix landed. The quota window rolls over ~24h after the day's first call, so
**around 15:30 UTC on 7 Aug** it should return to a clean 60 ticks an hour.

**PR #3 is not merged: GitHub never created a CI run for the branch** (their
queue, not our config — the workflow has no path filters). Verified locally
instead: 118 Apps Script + 27 Lambda tests green, and the diff grepped for real
domains. Merge once CI drains, or after re-checking locally.

## First thing to do next session

1. Check the heartbeat (command below). It should be ~60/hour.
2. Check the Apps Script execution log: `targeted scan examined 0 draft(s)` most
   minutes, `full scan examined N` once an hour.
3. **Send one real message through the relay.** The fix has proved it *runs*;
   it has not yet proved it *sends*. Nothing else matters until that is done.

```bash
aws cloudwatch get-metric-statistics --namespace EmailForwarder \
  --metric-name RelayHeartbeat --period 3600 --statistics Sum --region us-east-1 \
  --start-time "$(date -u -v-30H '+%Y-%m-%dT%H:%M:%SZ')" \
  --end-time "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
```

This metric is the first thing to look at whenever outbound seems wrong. It is
the only view of the relay from outside Google.

## Verified working (against the bytes SES actually transmitted)

Recovered from the inbound S3 copy, not from what the code appeared to produce:
send via subject token (`>>`) and via the `SES/Outbox` label; alias inference
from a thread, its parent, and the quoted body; Bcc containment; reply threading
both directions; per-domain sender names on the wire; failure alerts with stack
traces; IAM scoping (1 allow, 10 denials, checked against live AWS).

Watchdog **armed** — `TF_VAR_relay_enabled=true` lives in `.env`, so a later
`./deploy.sh` cannot silently disarm it. The canary runs hourly and emails only
on total silence, so it cannot itself become a source of noise.

## Deploy / ops

```bash
./deploy.sh              # phase 1, non-destructive
./deploy.sh --cutover    # flips MX to SES
```

⚠️ **Always apply with `enable_mx_cutover=true`**, or the MX records are
destroyed. `deploy.sh --cutover` does this; a bare `terraform apply` does not.

```bash
cd lambda && npm test            # 27 tests (run `npm ci` in lambda/src first)
cd appsscript && npm test        # 118 tests
cd appsscript && clasp push -f   # deploy the relay
```

Every alert shares the `[SES alert]` subject prefix; one Gmail filter on
`subject:"SES alert"` catches all of them, from all three runtimes.

Alert volume is capped in `notify.gs`: one per fault per 4h
(`ALERT_THROTTLE_MS`), and a flat ceiling of 4/hour and 20/day across every call
site (`ALERT_BUDGET_WINDOWS`). Raise them if it ever feels too quiet — the cap
reports how many it suppressed in the next alert that gets through.

Google's *own* trigger-failure mail is separate and not throttleable from code.
Apps Script → Triggers → `relayTick` → **Failure notification settings** →
*daily* rather than *immediately*.

Two functions to run from the Apps Script editor when something looks wrong:
`showConfig()` (what the relay actually parsed) and `inspectDrafts()` (what
Gmail actually returned). Both exist because silent fallbacks hid real bugs.

## Open threads

1. **Merge PR #3** once CI reports (see above).
2. **Untested: attachments.** Send a reply with a photo; confirm it arrives
   intact and appears in the Sent copy. SES caps a send at 10 MB.
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
- **An alert on a repeating condition needs a throttle**, or the first outage
  takes the alarm system down with it — the run-failure mail fired every tick
  and would have spent the separate 100-recipients-a-day quota.
- **SES's `FromEmailAddress` overrides the raw message's `From` header.** Pass
  the fully formatted value or the display name is silently discarded.
- **An optimisation that skips a write must compare against the last write, not
  the last read.** Comparing to the load-time value stranded in-flight records
  and reported every successful send as possibly-unsent.
- **Only `STATE_BUCKETS` survive a state reload.** Any other key set on the
  state object is dropped silently, so a "run once" flag stored there fires
  every minute forever.
- **Local `main` has no upstream tracking**, so `git pull` on it silently does
  nothing and a branch cut from it starts three commits stale. Branch from
  `origin/main`, not `main`.
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

Five separate bugs each cost multiple rounds because the failure was theorised
about rather than instrumented, and every one collapsed within minutes of making
the code report what it actually saw. Two lived in a *seam* — the SES call, and
the state write — while every individual component verified correct.

The quota failure was different and worth naming separately: every component was
correct, and the *cost* was the defect. It was diagnosed in one pass by asking
the heartbeat metric how many ticks had run before it died, then dividing.

**When each component checks out but the output is wrong, probe the seam. When
nothing is wrong but it stopped anyway, count something.**
