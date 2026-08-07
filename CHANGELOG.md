# Changelog

## Unreleased

### Fixed

- **Failure paths hardened after a noise review.** A quota death inside the
  per-draft classify loop now pauses the relay on that tick instead of being
  miscounted as a mailbox of "unreadable drafts" (one doomed Gmail call per
  remaining candidate). A quota death mid-send no longer emails per draft or
  marks the draft `failed` — the draft stays clean and sends itself once the
  quota returns. And a tick that runs but fails now still emits the heartbeat,
  so a failure streak no longer *also* draws the canary's hourly "relay
  silent" mail on top of the throttled run-failed alert; the watchdog now
  fires only on true silence (dead trigger, revoked auth, unloadable config).
- **A Gmail quota outage is now one email, not a day of noise.** When a tick
  dies on Apps Script's daily Gmail quota, the relay pauses its Gmail work and
  probes again every half hour instead of failing identically once a minute;
  paused ticks still emit the heartbeat, so the external watchdog no longer
  reports a running relay as silent. The quota alert throttles per episode
  (24 hours) rather than per the generic four-hour window, and its text now
  says the relay has paused and will resume itself. Covered by
  `quota-pause.test.mjs`, which drives `relayTick` end to end.

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

- **The relay exhausted Gmail's daily call quota and stopped sending.** Every
  tick scanned *every* draft in the mailbox and read each one's message, thread,
  and labels — about three Gmail calls per draft, sixty times an hour. Against
  Apps Script's 20,000 calls a day and a mailbox holding thirty abandoned
  drafts, that spent the whole day's allowance in roughly six hours, after which
  every tick died at `GmailApp.getDrafts()` with `Service invoked too many times
  for one day: gmail`. The scan no longer scales with the mailbox: it asks Gmail
  which threads carry the `SES/Outbox` label and which drafts were touched in
  the last day, and re-reads a draft's subject only when Gmail's message id
  shows it changed. An idle mailbox now costs two calls a tick whatever it
  holds. A full exhaustive sweep still runs hourly, so anything the narrow
  queries miss is sent late rather than never. See pre-mortem item 18.
- **A stuck relay emailed the same alert until it ran out of sending quota.**
  Run-level failures recur on every tick by nature, and the handler mailed each
  one — so a single fault also consumed the separate 100-recipients-a-day quota
  that per-draft alerts depend on. Identical run failures are now reported once
  every four hours, and beneath that `tryAlert()` enforces a flat ceiling of
  four alerts an hour and twenty a day across every call site — so no failure,
  present or future, can turn the alerting into the problem. The ceiling counts
  what it suppressed and says so in the next alert that gets through.
- **Removed a real domain and personal name from `lambda/test/lib.test.mjs`.**
  This repository is public, and the malformed-recipient regression fixture
  added in `c87e925` carried them verbatim. All test fixtures now use
  RFC 2606 reserved example domains. The values remain in git history — see the
  note in the README about rewriting it.
