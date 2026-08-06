# Handoff — 2026-08-06 20:20 CEST

## What this is

`custom-domain-email`: receive mail at your own domains in Gmail via SES →
Lambda → forward, and send as those domains. ~$1/month, all Terraform.
See `README.md`; relay design and failure analysis in
`docs/relay-premortem.md`.

**This repo is PUBLIC.** Real domains, addresses, and names belong only in
`config/domains.yaml`, `.env`, and Apps Script Script Properties — never in
tracked files. CI blocks AWS keys and tracked private config, but it does
**not** detect real domain names. Grep the diff before committing.

## Current state — the relay works

Gmail removes "Send as" for third-party addresses in **January 2027**. The
Apps Script relay in `appsscript/` replaces it and is **live and verified**:
marked draft → SES → delivered → filed in Sent, threading intact both ways.

Verified end to end: send via subject token, send via label, alias inference
from a thread, Bcc containment (blind recipients delivered, never disclosed),
reply threading, failure alerts with stack traces, Gmail filter routing.

**PR #1** — https://github.com/jjanczyszyn/custom-domain-email/pull/1 — open,
stacked on three unmerged `oversize-mail-handling` commits that were never
PR'd. Worth deciding whether to split them.

## Deploy / ops essentials

```bash
./deploy.sh              # phase 1, non-destructive
./deploy.sh --cutover    # flips MX to SES
```

⚠️ **Always apply with `enable_mx_cutover=true`**, or the MX records are
destroyed. `deploy.sh --cutover` does this; a bare `terraform apply` does not.

```bash
cd lambda && npm test        # 27 tests (run `npm ci` in lambda/src first)
cd appsscript && npm test    # 77 tests
cd appsscript && clasp push -f   # deploy the relay
```

Alerts from every source (DLQ notifier, canary, relay) share the `[SES alert]`
subject prefix; one Gmail filter on `subject:"SES alert"` catches them all.

## Open threads / next steps

1. **Merge PR #1**, deciding whether to split the stacked commits.
2. **Arm the relay watchdog** once you trust it:
   `terraform apply -var relay_enabled=true -var enable_mx_cutover=true`.
   Until then nothing tells you if the Apps Script trigger dies.
3. **Untested: attachments.** Send a reply with a photo and confirm it arrives
   intact and appears in the Sent copy. SES caps a send at 10 MB.
4. **Stale test drafts** from the debugging session may still be in Drafts,
   carrying failure markers. Delete them, or edit one to retry it.
5. **Git history still contains a real domain and name** from the test fixture
   in `c87e925`. Scrubbing needs a force-push, which rewrites hashes for anyone
   who cloned or forked. Zero forks as of today, so the cost is unusually low.
6. **SPF, separate PR.** One domain publishes SPF without `include:amazonses.com`
   and three publish none, so outbound rests entirely on DKIM alignment, which
   passes on all four. That domain has a live third-party sender, so change it
   on its own and test independently.

## Time-sensitive

- **January 2027** — Gmail "Send as" for third-party addresses is removed.
  The relay must be working before then. It is; keep it that way.
- **Now–Q4 2026** — the window where both paths work, and the only time the
  relay can be compared against a known-good reference.

## Hard-won gotchas (all in docs/relay-premortem.md)

- Apps Script advanced services return `bytes` fields as **Byte[]**, already
  decoded — not the base64 string the REST API documents.
- `clasp create-script` **overwrites `src/appsscript.json`**, dropping the
  advanced-service and scope declarations. Restore from git before pushing.
- Changing the manifest requires **re-authorisation**: run any function from
  the editor, or the installed trigger keeps failing under the old grant.
- Gmail's stored draft closes `</body></html>` **before** the quoted reply.
  Gmail's own sender repairs this; the relay must too, or recipients see an
  apparently empty message.
- Gmail does not always thread a reply with its parent, and may record no
  `In-Reply-To` at all — hence four layers of alias inference.
