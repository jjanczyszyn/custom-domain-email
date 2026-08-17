# Pre-mortem: the Gmail → SES outbound relay

> It is March 2027. The relay has been the only way to send as our domains for
> two months, and it has gone badly wrong. What happened?

This document was written *before* the code, and the code was then written to
close each item. Every failure below names its mitigation and where that
mitigation lives. Items marked **ACCEPTED** are real risks we chose to live
with, with the reasoning recorded.

Ranked by how bad the outcome is, not how likely.

---

## 1. A client received the same email four times

**The worst outcome.** Duplicate mail to a coaching client is embarrassing in a
way a delayed send is not.

The mechanism: the script hands the message to SES, then dies before it can
clear the outbox marker — Apps Script's 6-minute execution ceiling, a Google
infrastructure blip, a quota trip. One minute later the trigger fires again,
finds the draft still marked, and sends it again. And again.

**Mitigation — record the draft as consumed *before* calling SES.**
`processDraft()` writes a `consumed` entry and persists it, and only then
transmits. A crash at any point after that leaves a draft that is no longer
eligible, so the next run ignores it. The failure mode inverts from "sends
repeatedly" to "silently doesn't send", which item 3 then catches.

**Mitigation — an explicit in-flight record.** Alongside `consumed`, an
`inflight` entry carries the generated Message-ID; it is cleared only after the
message is filed and the draft deleted. A record still present on the next run
means a send whose outcome is *unknown*. Both live in the single `_relayState`
property — see `state.gs` for why one key rather than one per draft.

**Corollary — a failure *after* SES accepts must not clear `consumed`.** If
filing the Sent copy throws, the message has still gone out; clearing the marker
would send it again. `processDraft()` tracks whether SES accepted and routes
those two cases to different outcomes in `notify.gs`.

**Policy: never auto-retry an unknown-state send.** We cannot ask SES "did you
accept this message". So an orphaned in-flight record does not trigger a retry
— it labels the draft `SES/Needs-Review` and emails the alert address saying
"this may or may not have gone out; check your Sent folder and decide."
Duplicates are worse than a send you have to confirm by hand.

## 2. Every Bcc recipient was exposed to everyone else on the email

Gmail's raw draft MIME includes the `Bcc:` header. Hand that raw message to SES
unchanged and whether the header survives to recipients depends on SES's
internal behaviour — which is not a thing to bet a client's privacy on.

**Mitigation — strip `Bcc` from the transmitted bytes, unconditionally.**
`buildOutbound()` in `mime.gs` removes `Bcc` (and `Resent-Bcc`) from the
outgoing headers and returns the blind recipients separately, to be passed to
SES via the `Destination.BccAddresses` API parameter instead. Delivery is
driven by the API parameter; the header is never transmitted. This is the same
lesson the inbound path already learned — the envelope and the headers are
different things (`lib.mjs:142`).

The copy filed in Sent *keeps* its `Bcc` header, because that is what Gmail
does natively and you need to see who you blind-copied. Two variants, one
Message-ID. Covered by `mime.test.mjs`.

## 3. Mail sat unsent for a week and nobody noticed

The trigger got disabled — an Apps Script auth lapse, a Google-side pause after
repeated failures, someone deleting it during unrelated cleanup. Drafts piled
up marked-but-unsent. No error, because nothing ran to produce one.

This is the exact failure the inbound canary already exists to catch, and it
needs the same answer: *the absence of activity is itself the alarm.*

**Mitigation — a heartbeat that runs on the AWS side, not in Apps Script.** A
watchdog cannot live inside the thing it watches. Every successful relay run
writes a `RelayHeartbeat` metric to CloudWatch. The existing canary Lambda,
which already runs hourly and already checks `CanaryHeartbeat`, also checks
that the relay has reported in within its window — and emails you when it has
not. If Apps Script dies entirely, AWS notices.

~~**Mitigation — a stale-draft sweep.**~~ *Superseded, and removed.* This was
going to count drafts left marked for more than fifteen minutes. It became
redundant once an unresolvable draft started reporting itself on the first tick
(item 8): a marked draft now either sends, fails loudly, or is inside its
settling window, so there is no silent limbo left for a sweep to find. It was
carried for a while as unreachable code publishing a CloudWatch metric that was
always zero — a monitoring signal that reads "healthy" by construction is worse
than no signal, so both are gone.

## 4. Replies stopped threading and every conversation fragmented

The message SES transmitted and the copy filed in Sent carried different
`Message-ID` values. The recipient's reply cites the transmitted ID; Gmail
holds the archived one; nothing matches; the conversation splits into
fragments.

**Mitigation — generate the Message-ID ourselves, before sending.** The script
mints `<uuid@domain>` and writes it into the headers, so the transmitted bytes
and the archived bytes carry the same identifier. We never let SES assign one.
`ensureMessageId()` is pure and tested.

**Verified, not assumed:** the inbound forwarder preserves `In-Reply-To`,
`References`, and `Message-ID` — `rewrite()` at `lambda/src/lib.mjs:112` strips
only `Return-Path`, `Sender`, `DKIM-Signature`, and `X-SES-*`. So a reply
coming back in threads against the archived copy. The round trip closes.

## 5. It sent a half-written draft

You marked the draft, then kept typing. The trigger fired mid-sentence.

**Mitigation — a settling delay.** A draft must be unmodified for
`SETTLE_SECONDS` (default 45) before it is eligible. `relay.gs` compares the
draft's last-saved date against now and defers anything still warm. This
doubles as the undo window: the send is not committed until roughly a minute
after you mark it, and removing the marker in that window cancels it.

## 6. Two trigger runs overlapped and raced each other

Apps Script does not guarantee a run finishes before the next fires. A slow run
processing a large attachment can still be live when the next minute ticks.

**Mitigation — `LockService.getScriptLock()`** with a zero-wait acquisition. A
second concurrent run exits immediately rather than queuing, because the work
is idempotent-by-marker and will be picked up on the next tick anyway.

## 7. Sending broke completely and every send failed

Sub-cases, all landing in the same place:

- **SigV4 signing bug.** Signature mismatches are unforgiving and easy to get
  wrong. Mitigated by keeping the signing algorithm pure and injecting the
  crypto primitives, so it is unit-tested against AWS's published
  `sigv4_testsuite` vectors under Node (`sigv4.test.mjs`) rather than debugged
  live in the Apps Script editor.
- **IAM credentials revoked or rotated.** Returns 403. Surfaced as a failure
  email naming the status code.
- **The message exceeds 10 MB.** SES's hard send ceiling — the same limit the
  inbound path already works around. Checked *before* transmitting so it fails
  cleanly with a useful message instead of a raw API error.
- **A malformed recipient address.** SES rejects the entire send over one bad
  token. This bit the inbound path already, and the fix is reused: recipient
  addresses are validated before the call and unparseable ones are reported by
  name rather than silently dropped, because on outbound a dropped recipient
  means a person who didn't get your email.

**Mitigation — failure is always an email.** Matching the project's existing
philosophy: no alarms, no dashboards. Any send that fails labels the draft
`SES/Failed`, leaves it intact and editable, and emails `ALERT_EMAIL` with the
recipient, subject, and the actual error.

## 8. It sent from the wrong domain

After January 2027 Gmail will not offer the alias in the From picker at all —
every draft is authored as the Gmail address. Something must decide which of
the four domains a message goes out as, and picking wrong means a client sees
the wrong brand.

**Mitigation — explicit intent first, then evidence, then refuse.** An explicit
subject token or `SES/from:` label wins outright. Failing that, the alias is
inferred from the domain the thread was originally addressed to,
which is the same rule as Gmail's "reply from the same address" setting. For a
new message it must be stated explicitly, via the `SES/from:<domain>` label or
the subject token (`>>example.net Subject here`). If neither is available the
script **refuses to send** and asks, rather than guessing a default. A message
that doesn't go out is recoverable; one sent under the wrong brand is not.

## 9. The marker was unusable on a phone

The design assumed labelling a draft. In the Gmail mobile app a draft opens
straight into the compose view, which has no labelling affordance — you have to
back out to the Drafts list and long-press the conversation, and on iOS it may
not be offered at all. Given how much of this workflow is phone-driven, a
web-only trigger would have been a design failure.

**Mitigation — two independent markers.** A label (`SES/Outbox`) for web, and a
**subject prefix token** (`>>`) that works anywhere text can be typed,
including mobile compose. The token is parsed from the `Subject` header — no
MIME body parsing, no encoding minefield — and stripped before transmission.
Either marker sends; you never have to remember which surface you're on.

## 10. The AWS key leaked

The relay needs credentials in Script Properties. Anyone with edit access to
the script can read them, and Apps Script projects are easy to share by
accident.

**Mitigation — a dedicated, minimally-scoped IAM user.** Not the SMTP user, not
anything reused. `ses:SendEmail` and `ses:SendRawEmail` only, restricted by
condition to the four verified identities. A leak lets the holder send as your
domains — bad — but grants no read access to inbound mail in S3, no ability to
change DNS, and nothing else in the account. Provisioned in Terraform
alongside the existing SMTP user so it is revocable with one apply.

**ACCEPTED:** anyone with access to the Gmail account can already send as these
domains today. The relay does not widen that.

## 11. Deliverability quietly degraded

Outbound already goes through SES today via Send-As, so the relay changes the
compose surface, not the sending path — SPF/DKIM/DMARC behaviour is unchanged
by definition. Recorded here because the audit surfaced two real weaknesses
that predate this work:

- `example.net` publishes `v=spf1 include:_spf.maileroo.com
  include:_spf.google.com ~all` — **no `include:amazonses.com`**. SES-sent mail
  therefore fails SPF and is carried entirely by DKIM alignment.
- `example.com`, `example.org`, and `example.test` publish no SPF record
  at all (neutral, not a fail — again carried by DKIM).

DKIM is verified and passing on all four, so DMARC aligns and mail is
deliverable. But it rests on a single mechanism with no margin. **Not fixed in
this change** — `example.net` has a live Maileroo sender and editing its SPF is
a separate, independently-testable change that should not ride along with a new
relay. Flagged for its own PR.

## 12. Nobody could tell if a send had actually worked

**ACCEPTED, with instrumentation.** There is no delivery receipt. Success means
"SES accepted the message", not "it arrived". The archived Sent copy is written
only after SES returns a 200 with a message ID, so a message in Sent means SES
took responsibility for it. Bounces land in the existing inbound pipeline and
arrive in the inbox like any other mail.

---

---

## Found in testing, not in the pre-mortem

**13. One unrelated draft stopped all outbound mail.**

`GmailApp.getDrafts()` returns drafts that it will then refuse to read —
`draft.getMessage()` throws `Gmail operation not allowed` for a scheduled send,
and apparently for other states too. The scan loop had no per-draft guard, so a
single such draft anywhere in the mailbox aborted the entire run, every run.
Nothing would send, and the only visible symptom was an execution log nobody
reads. Found immediately on a mailbox with 29 pre-existing drafts.

This is the same *class* as item 3 — the relay stops and stays quiet — but the
pre-mortem only imagined the trigger dying, not the trigger running fine and
failing on its first line of real work. The lesson worth keeping: an iteration
over other people's data needs a per-item guard, because the loop's failure mode
is not "skip one" but "process none".

**Mitigation:** each draft is classified inside its own try/catch; unreadable
ones are counted and logged, and the run continues. The relay heartbeat still
fires, so item 3's watchdog stays meaningful.

**14. A generic runtime error cost three wrong fixes.**

Reading a draft failed with `Could not decode string`. That message names the
decoder's disappointment and nothing about the input, and three plausible
theories were shipped against it in turn — unpadded base64, base64url alphabet,
a Blob payload — each wrong, each costing a full test cycle.

The actual cause: Apps Script's advanced services *decode* protobuf `bytes`
fields for you and return a `Byte[]`, not the base64 string the REST API
documents. There was never anything to decode. Every fix was operating on a
premise that was false from the start.

What ended it was not a better theory but making the failure self-describing:
the error now reports `typeof`, constructor, length, and the first bytes of what
it was actually handed, and the alert email carries the stack. The very next
failure said `constructor=Array` and `head=82,101,99,...` — ASCII for
`Received: ` — which named the cause outright.

**The lesson worth keeping:** when an error message describes a symptom rather
than an input, stop theorising and spend the cycle on making the error name its
input. One diagnostic beats three guesses, and it is cheaper than the first
guess. `inspectDrafts()` in `setup.gs` exists for the same reason.

**15. Recipients saw an empty message.**

Every relayed reply arrived looking blank — the entire body collapsed behind
the recipient's "trimmed content" marker, so a reader would not know there was
anything to expand. Not a delivery failure, and invisible from the sender's
Sent folder: strictly worse than a bounce, because it looks like it worked.

The cause is in Gmail's stored draft, not in anything the relay does:

    <html><body><div>your text</div></body></html>
    <br><div class="gmail_extra">…quote…</div>

The document is closed *before* the quoted reply, leaving the quote outside
`<body>`. Gmail's own sender normalises this on the way out. The relay bypasses
that sender, so the malformed markup reaches the recipient as-is and their
client collapses the lot.

**Mitigation:** `repairHtmlParts()` relocates the stray closing tags to the end
of each part. Content is never added or removed. Verified against the bytes SES
actually transmitted, pulled from the inbound S3 copy, rather than from what the
composer appeared to produce.

**The lesson worth keeping:** passing a body through byte-for-byte is not the
same as passing it through *correctly*. The relay was faithfully forwarding
markup that only ever worked because Gmail repaired it at send time — an
invariant supplied by the component we replaced. When you take over one stage of
a pipeline, audit what that stage was silently fixing.

*Recurrence, found live:* the repair pattern-matched the WIRE bytes, and both
of Gmail's transfer encodings defeat that. Quoted-printable soft breaks can
split a closing tag across lines; base64 — which Gmail selects for emoji-heavy
text parts, not just attachments — hides the markup entirely, and the old code
explicitly skipped base64 segments as "attachments". So every emoji reply
shipped broken while every ASCII test passed: the test inputs and the failing
inputs took different encodings. The repair now decodes each text/html part,
fixes it, and re-encodes only when the fix changed something
(`encoded-repair.test.mjs` pins both gaps and the do-no-harm cases). The added
lesson: a transformation on encoded content must run in the content's domain,
not the encoding's — and a test corpus must include the input *shapes* that
pick different encodings, because "same text, more emoji" is a different wire
format.

**16. Every message went out showing "hello" instead of the brand.**

Each domain is configured with a sender name, so recipients should see
*Toward Love* rather than the bare local part. They saw `hello`. Not a delivery
failure and invisible in the Sent copy — it just looked slightly wrong to
everyone who received anything.

Every layer verified correct in isolation: the property was set, it parsed into
the right map, `displayNameFor()` returned the name, and `buildOutbound()` wrote
`From: "Vibes Queen" <hello@…>` into the transmitted bytes. Confirmed by running
the real code in Node, and by having the relay email its own parsed
configuration.

The value was destroyed one step later. **SES's `FromEmailAddress` parameter
overrides the `From` header in the raw message** — we handed SES a perfect
header and, alongside it, the bare address. SES did as instructed.

**Mitigation:** `buildOutbound()` returns the formatted `from`, and that is what
goes to SES, so the header and the API parameter cannot disagree. Two tests pin
it, one asserting the two stay identical.

**The lesson worth keeping:** when every component verifies correct but the
output is wrong, the bug is in a *seam*, not a component — and specifically in
the seam you haven't instrumented. Three rounds went into re-checking layers
that were already proven correct. The moment the header was verified right in
Node, the only unexamined step left was the API call, and that is where the
next probe should have gone.

**17. Every successful send reported itself as possibly-unsent.**

Each send emailed "a send was interrupted before it could be confirmed, so it
may or may not have gone out" — the item 1 machinery firing on messages that had
gone out perfectly. Alarming, unactionable, and on every single send, which is
how a real warning gets trained into noise.

A send persists an in-flight entry *before* the network call so a crash is
detectable, then removes it after. The tick therefore ends with state identical
to how it started. An optimisation skipped the final write when the end state
matched the state at load — but the property still held the intermediate write,
so the entry was stranded and the next run reported it as unconfirmed.

**Mitigation:** the dirty check moved into `saveState()`, which compares against
what it last actually *wrote* rather than what was loaded. `state.test.mjs`
pins it, and reintroducing the old comparison fails that test.

**The lesson worth keeping:** an optimisation that skips a write has to compare
against the last write, not the last read. The two diverge exactly when
something wrote in between — which is the case the optimisation is most likely
to be reasoning about incorrectly.

**18. The relay ran out of Gmail, six hours after going live.**

Every tick died on its first line of real work:

```
Exception: Service invoked too many times for one day: gmail.
    at relayTick (relay:37:27)
```

Line 37 was `GmailApp.getDrafts()`. Nothing was wrong with the code that
followed it; there was simply no Gmail left to spend.

Apps Script meters Gmail calls at 20,000 a day on a consumer account. The scan
walked *every* draft in the mailbox and classified each one — reading its
message, its thread, and its thread's labels — so a tick cost roughly one call
per draft, times three. At thirty abandoned drafts and a trigger every minute,
that is around 90 calls a minute, or 130,000 a day against an allowance of
20,000. The relay was never going to last a day; it lasted about six hours.

The mailbox was not a surprise — item 13 was found *on those same drafts*, and
this document has said "29 pre-existing drafts" since. What went unexamined was
what it costs to look at them, sixty times an hour, forever. A correctness
review asked whether the loop handled every draft correctly. It did. Nobody
asked what the loop cost, because cost is not a behaviour you see in a test.

The failure then made itself worse. The top-level handler emails on any run
failure, and this failure recurred on all 1,440 ticks — so a single stuck relay
also spent the *separate* 100-recipients-a-day sending quota on 100 identical
copies of the same alert, which is the quota real per-draft alerts depend on.

**Mitigation:** the per-tick scan no longer scales with the mailbox. It asks
Gmail two narrow questions instead — which threads carry the Outbox label, and
which drafts were touched in the last day — and only reads a subject when the
draft has actually changed, which Gmail reveals for free by replacing a draft's
message id on every edit. An idle mailbox now costs two calls a tick regardless
of how many drafts it holds, and the thirty abandoned ones cost nothing at all.

Three layers keep that safe to be wrong. The message-id memo is re-checked
every ten minutes anyway, in case a marking ever leaves the id alone. The full
exhaustive walk still runs once an hour, so anything the narrow queries miss
goes out late rather than never. `scan.test.mjs` counts the reads the scan
performs, because here the cost *is* the behaviour under test.

The alerting got two guards, because they fail separately. Run-level failures
are throttled to one per fault every four hours, which stops the *same* failure
repeating. Underneath that, `tryAlert()` enforces a flat ceiling — four alerts
an hour, twenty a day, across every call site — which bounds everything else:
any mix of faults, and any future code that decides to email. The ceiling keeps
a count of what it held back and says so in the next alert that gets through,
because a cap that silently drops mail is worse than no cap at all: it makes
"nothing is wrong" and "everything is wrong" look identical from the inbox.

The outage's long tail taught one more round. The quota died the evening before
it could reset, and the *aftermath* was itself noisy: the four-hour throttle
re-raised the same episode all day (six copies of one fact), every tick burned
a doomed Gmail call and an error log line, and — because the heartbeat was only
emitted on success — the external watchdog spent the outage emailing "relay
silent" about a relay that was running fine and saying so in its own log.

So a quota death now suspends Gmail work. The tick that hits the quota arms a
half-hour pause (`pauses.gmail` in the state bundle); ticks inside it load
state, emit the heartbeat, and exit without a single Gmail call. The heartbeat
during a pause is the truth — the *trigger* is alive, which is what the
watchdog exists to check; the inability to send was already reported by mail.
When the pause expires, one probe tick asks Gmail again: still dead re-arms the
pause silently, recovered resumes scanning, at most half an hour late against
an outage measured in hours. The quota alert itself is throttled per episode —
24 hours, matching the length of the condition it reports — so an exhausted
quota is one email, and its recovery is announced by the relay simply working.

**The lesson worth keeping:** a loop that is correct can still be unaffordable,
and quota is consumed by the work you skip as well as the work you do. Anything
running on a timer should be costed per tick and multiplied out to a day —
"correct" and "sustainable" are separate reviews, and only one of them was done.

A second lesson, cheaper to state: an alert that fires on a repeating condition
needs a throttle, or the first outage takes the alarm system down with it. And
a third, learned from the throttle itself: match the throttle to the length of
the condition, not to a round number — a day-long outage reported every four
hours is still five emails of noise about one fact.

**19. An alert arrived about a failure that had already fixed itself.**

At 00:10 UTC on 17 Aug 2026 a tick died with `Gmail operation not allowed`,
thrown by `GmailApp.getUserLabelByName()` — the first line of real work in a
targeted scan. Nothing was wrong with the mailbox, the label, or the relay: the
next tick, a minute later, ran normally, and so did the 1,000-odd after it. The
only artefact of the whole event was the email it sent.

Gmail's backend refuses the occasional valid call. The relay already knew that
string in one place — item 13, where `getMessage()` throws it at an unreadable
draft and the loop skips that draft — but at the run level there was no such
notion, so the same momentary refusal aborted the tick and was reported as a
failure. It *was* a failure; it was simply over by the time the mail arrived.

That is worse than it sounds. This relay's entire failure UX is email, and an
alert stream that contains events requiring no action is one the operator
starts skimming — which is precisely the state in which a real outage goes
unread. The four-hour throttle bounds the *volume* of such mail; it does
nothing about the first copy, which is the one that costs the credibility.

**Mitigation:** a run-level failure Gmail is known to retract — "operation not
allowed", the *short-term* rate limit, "service unavailable", and friends — is
counted rather than reported. `faults.gmail` in the state bundle holds how many
consecutive ticks have now died that way; three (about three minutes of
retrying, at one tick a minute) is an email, and any tick that completes clears
the count. A blip is therefore invisible outside the execution log, a genuine
outage is reported within minutes and carries how long it has persisted, and
anything the classifier does not recognise alerts on the first tick as before.
Misjudging a fault as transient costs three minutes; misjudging a blip as a
fault costs an email about nothing, so the patterns are deliberately broad.

The same change separates the short-term rate limit ("invoked too many times in
a short time", which clears in seconds) from the daily quota of item 18, which
it reads almost identically to. Matched together, a few seconds of rate
limiting armed a half-hour Gmail pause and sent a page of prose about a daily
quota that had not run out.

**The lesson worth keeping:** "did it fail?" is the wrong question to alert on
for anything that retries on its own — the useful one is "is it still failing?"
A system that retries every minute can answer that itself, for the price of a
counter, and should, because every alert that turns out to need no action
spends some of the attention the next one depends on.

## Deliberately not solved

- **Undo Send.** Gmail's is a client-side hold, unavailable to us. The
  45-second settling delay in item 5 is the substitute: unmark within it and
  nothing goes out.
- **Scheduled send.** Gmail's scheduler sends through Gmail, so it would go out
  as the Gmail address and bypass the relay entirely. Marking a draft schedules
  nothing; write it and mark it when you want it gone.
- **Read receipts / open tracking.** Out of scope and unwanted.
- **Sub-minute latency.** Apps Script's floor for time-driven triggers is one
  minute. Irreducible without abandoning Apps Script.
