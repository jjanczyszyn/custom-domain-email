# Handoff — 2026-08-06 16:54 CEST

## What this is

`custom-domain-email`: receive mail at your own domains in Gmail via SES →
Lambda → forward, and send as those domains. ~$1/month, all Terraform.
See `README.md`; relay design in `docs/relay-premortem.md`.

**This repo is PUBLIC.** Real domains and addresses belong only in
`config/domains.yaml` and `.env` (both gitignored). Test fixtures use RFC 2606
reserved domains. CI blocks AWS keys and tracked private config — but it does
**not** detect real domain names, so that one is on us.

## Current state

**PR #1 open, all CI green**: https://github.com/jjanczyszyn/custom-domain-email/pull/1
Branch `outbound-relay`, stacked on the three unmerged `oversize-mail-handling`
commits (never PR'd — worth deciding whether to split).

Terraform is **already applied** (3 added, 1 changed, 0 destroyed). The
`multi-domain-email-relay` IAM user exists and its scoping is verified against
real AWS: sending as a verified domain works; sending as an unowned domain and
reading the inbound S3 bucket are both denied.

## Why the relay exists

Gmail removes **"Send as" for third-party addresses in January 2027**, and will
restrict *new* configurations before then (we are in that window now). Inbound
forwarding is explicitly unaffected. The relay in `appsscript/` replaces the
outbound half while keeping composing in Gmail.

## Deploy / ops essentials

```bash
./deploy.sh              # phase 1, non-destructive
./deploy.sh --cutover    # flips MX to SES
```

⚠️ **Always apply with `enable_mx_cutover=true`** once cut over, or the MX
records get destroyed. `deploy.sh --cutover` does this; a bare
`terraform apply` does not.

```bash
cd lambda && npm test        # 27 tests (needs `npm ci` in lambda/src first)
cd appsscript && npm test    # 46 tests
```

## Open threads / next steps

1. **Merge PR #1**, deciding whether to split off the stacked commits.
2. **Install the relay** — `appsscript/README.md` has the steps. Not started;
   the Apps Script project does not exist yet. Nothing sends through it until
   `setUp()` runs. Verify with `checkAws()` → `sendTestEmail()` → a real reply.
3. **Then** `terraform apply -var relay_enabled=true` to arm the watchdog. Doing
   this before the relay runs just generates false alerts.
4. **Add remaining Send-As aliases NOW if wanted.** `hello@` is configured for
   one domain only. Google may block *new* Send-As configurations at any point
   this quarter; existing ones work until January 2027. Adding them buys a
   working fallback to compare the relay against while both paths exist.
5. **Decide on git history.** A real domain and personal name are still in
   history from `c87e925`. Scrubbing needs a force-push, which rewrites hashes
   for anyone who cloned or forked. Working tree is clean either way.
6. **SPF, separate PR.** `toward.love` publishes SPF listing Maileroo and Google
   but not `amazonses.com`; the other three publish no SPF. All four pass DMARC
   via DKIM alignment, so mail is deliverable — but on one mechanism with no
   margin. `toward.love` has a live Maileroo sender, so change it on its own.

## Time-sensitive

- **January 2027** — Send-As dies. Relay must be working before then.
- **Now–Q4 2026** — window where both paths work. The only time the relay can be
  A/B'd against a known-good reference.
