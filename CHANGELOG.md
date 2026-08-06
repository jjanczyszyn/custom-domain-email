# Changelog

## Unreleased

### Added

- **Outbound relay (Gmail → SES), replacing Gmail "Send as".** Google removes
  "Send as" for third-party addresses in January 2027, which is how this project
  has sent mail as your own domains. Inbound forwarding is unaffected. The relay
  keeps composing in Gmail: mark a draft with the `SES/Outbox` label or a `>>`
  subject prefix, and an Apps Script trigger sends it through SES as one of your
  verified domains, then files the copy in your Sent folder with the same
  Message-ID so replies keep threading. See `appsscript/`.
- **A pre-mortem for the relay** (`docs/relay-premortem.md`), written before the
  code and covering duplicate sends, Bcc disclosure, silent trigger death,
  thread fragmentation, half-written drafts, and wrong-domain sends. Each item
  names the mitigation that closes it.
- **Relay watchdog.** The canary Lambda now also checks a `RelayHeartbeat`
  metric and emails when the relay goes quiet, because a trigger that dies
  inside Apps Script cannot report its own death. Off by default; enable with
  `-var relay_enabled=true` once the relay is installed.
- **A dedicated `*-relay` IAM user**, scoped to `ses:SendEmail`/`SendRawEmail`
  on the verified domain identities plus `cloudwatch:PutMetricData` on one
  namespace. Separate from the SMTP user so the credentials that live in Google
  can be revoked on their own.
- **CI** (`.github/workflows/ci.yml`): unit tests for the forwarder and the
  relay, `terraform fmt -check` and `validate`, and a check that no AWS key or
  private config reaches a tracked file.

### Changed

- `canary/index.mjs`: `heartbeatsInWindow()` now takes a metric name and window
  so it can serve both the inbound and relay checks.

### Fixed

- **Removed a real domain and personal name from `lambda/test/lib.test.mjs`.**
  This repository is public, and the malformed-recipient regression fixture
  added in `c87e925` carried them verbatim. All test fixtures now use
  RFC 2606 reserved example domains. The values remain in git history — see the
  note in the README about rewriting it.
