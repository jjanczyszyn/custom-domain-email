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

- **Per-domain sender names.** `DOMAIN_NAMES` maps each domain to the name
  recipients see, so mail arrives from "Example Co" rather than the bare local
  part. Note that SES's `FromEmailAddress` overrides the raw message's `From`
  header, so the formatted value is passed to the API as well.
- **`showConfig()` and `inspectDrafts()`**, run from the Apps Script editor, to
  report what the relay actually parsed and what Gmail actually returned. Both
  exist because silent fallbacks made three separate bugs invisible.

### Changed

- `canary/index.mjs`: `heartbeatsInWindow()` now takes a metric name and window
  so it can serve both the inbound and relay checks.
- The relay is split by responsibility — `state.gs`, `inference.gs`, `gmail.gs`,
  `notify.gs` — leaving `relay.gs` as the decisions alone.
- All relay runtime state lives under one `_relayState` property rather than one
  per draft, so Script Properties shows only real configuration.
- CI cancels superseded runs, so a queued run killed by a later push no longer
  reports as a failure.

### Removed

- The stale-draft sweep and its `RelayStuckDrafts` metric. The sweep was
  unreachable and the metric always published zero; an unresolvable draft now
  reports itself on the first tick instead.

### Fixed

- **Removed a real domain and personal name from `lambda/test/lib.test.mjs`.**
  This repository is public, and the malformed-recipient regression fixture
  added in `c87e925` carried them verbatim. All test fixtures now use
  RFC 2606 reserved example domains. The values remain in git history — see the
  note in the README about rewriting it.
