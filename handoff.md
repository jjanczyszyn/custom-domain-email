# Handoff — 2026-08-06 22:40 CEST

## What this is

`custom-domain-email`: receive mail at your own domains in Gmail via SES →
Lambda → forward, and send as those domains. ~$1/month, all Terraform.
See `README.md`; the relay's design and every failure it defends against are in
`docs/relay-premortem.md`.

**This repo is PUBLIC.** Real domains, addresses, and names belong only in
`config/domains.yaml`, `.env`, and Apps Script Script Properties — never in
tracked files. CI blocks AWS keys and tracked private config, but it does
**not** detect real domain names. Grep the diff before committing.

## Current state — working and verified

Gmail removes "Send as" for third-party addresses in **January 2027**. The Apps
Script relay in `appsscript/` replaces it and is **live**. Verified end to end
against the bytes SES actually transmitted (recovered from the inbound S3 copy),
not against what the code appeared to produce:

- send via subject token and via label
- alias inference from a thread, its parent, and the quoted body
- Bcc containment — blind recipients delivered, never disclosed
- reply threading, both directions
- per-domain sender names on the wire
- failure alerts with stack traces, and the Gmail filter that files them
- IAM scoping: 1 allow, 10 denials, checked against live AWS

Watchdog is **armed** (`TF_VAR_relay_enabled=true` in `.env`, so a later
`./deploy.sh` cannot silently disarm it). The canary emails if the relay goes
quiet for an hour; verified by invoking it and confirming no false alarm.

## Deploy / ops essentials

```bash
./deploy.sh              # phase 1, non-destructive
./deploy.sh --cutover    # flips MX to SES
```

⚠️ **Always apply with `enable_mx_cutover=true`**, or the MX records are
destroyed. `deploy.sh --cutover` does this; a bare `terraform apply` does not.

```bash
cd lambda && npm test            # 27 tests (run `npm ci` in lambda/src first)
cd appsscript && npm test        # 87 tests
cd appsscript && clasp push -f   # deploy the relay
```

Alerts from every source share the `[SES alert]` subject prefix; one Gmail
filter on `subject:"SES alert"` catches them all.

## Open threads / next steps

1. **Untested: attachments.** Send a reply with a photo, confirm it arrives
   intact and appears in the Sent copy. SES caps a send at 10 MB.
2. **Leftover test mail.** Several `[SES alert] config dump` and `namecheck*`
   messages are in the inbox, plus stale drafts. Safe to delete.
3. **Git history still contains a real domain and name** from the test fixture
   in `c87e925`. Scrubbing needs a force-push, which rewrites hashes for anyone
   who cloned or forked. Zero forks, so the cost is unusually low.
4. **SPF, separate PR.** One domain publishes SPF without `include:amazonses.com`
   and three publish none, so outbound rests entirely on DKIM alignment, which
   passes on all four. That domain has a live third-party sender, so change it
   on its own and test independently.

## Time-sensitive

- **January 2027** — Gmail "Send as" for third-party addresses is removed. The
  relay must be working before then. It is; keep it that way.
- **Now–Q4 2026** — the window where both paths work, and the only time the
  relay can be compared against a known-good reference.

## Hard-won gotchas (all written up in docs/relay-premortem.md)

- **SES's `FromEmailAddress` overrides the raw message's `From` header.** Pass
  the fully formatted value or the display name is silently discarded.
- Apps Script advanced services return `bytes` fields as **Byte[]**, already
  decoded — not the base64 string the REST API documents.
- `clasp create-script` **overwrites `src/appsscript.json`**, dropping the
  advanced-service and scope declarations. Restore from git before pushing.
- Changing the manifest requires **re-authorisation**: run any function from the
  editor, or the installed trigger keeps failing under the old grant.
- The Apps Script editor caches its file list — **reload the tab** after a push
  or new functions will not appear in the Run dropdown.
- Gmail's stored draft closes `</body></html>` **before** the quoted reply.
  Gmail's own sender repairs this; the relay must too, or recipients see an
  apparently empty message.
- Gmail does not always thread a reply with its parent, and may record no
  `In-Reply-To` at all — hence six layers of alias inference.

## Debugging posture

Three separate bugs cost multiple rounds each because the failure was theorised
about rather than instrumented. Every one collapsed within minutes of making the
code report what it actually saw. `showConfig()` and `inspectDrafts()` exist for
this; when a component chain all verifies correct but the output is wrong, probe
the *seam* — that is where all three actually lived.
