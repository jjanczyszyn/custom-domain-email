/**
 * setup.gs — one-time installation and manual checks.
 *
 * Run setUp() once from the Apps Script editor after filling in Script
 * Properties. Credentials are never written here, so this file stays safe to
 * commit to a public repository.
 */

/** Create the labels, install the trigger, and verify the configuration. */
function setUp() {
  var cfg = getConfig(); // throws with a list of anything missing

  ensureLabel(LABEL_OUTBOX);
  ensureLabel(LABEL_FAILED);
  ensureLabel(LABEL_REVIEW);
  for (var i = 0; i < cfg.domains.length; i++) {
    ensureLabel(LABEL_FROM_PREFIX + cfg.domains[i]);
  }

  removeTriggers();
  ScriptApp.newTrigger('relayTick').timeBased().everyMinutes(1).create();

  console.log(
    'Relay installed.\n' +
      '  Domains:      ' + cfg.domains.join(', ') + '\n' +
      '  Default alias: ' + cfg.defaultLocalpart + '@<domain>\n' +
      '  Region:       ' + cfg.region + '\n' +
      '  Alerts to:    ' + cfg.alertEmail + '\n\n' +
      'Mark a draft with the "' + LABEL_OUTBOX + '" label or a "' + cfg.subjectToken + '" subject ' +
      'prefix to send it. Run checkAws() to confirm AWS credentials work.'
  );
}

/** Remove every trigger this project owns. Safe to run repeatedly. */
function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'relayTick') ScriptApp.deleteTrigger(triggers[i]);
  }
}

/**
 * Confirm the AWS credentials and signing work, without sending anything.
 *
 * Deliberately sends a request SES will reject on content rather than on
 * authentication: a 400 proves the signature was accepted, which is the part
 * worth verifying. A 403 means the credentials or the signing are wrong.
 */
function checkAws() {
  var cfg = getConfig();
  var host = 'email.' + cfg.region + '.amazonaws.com';
  var res = awsFetch(cfg, 'ses', host, '/v2/email/outbound-emails', '{}', 'application/json');

  if (res.status === 403) {
    console.error('403 — credentials rejected or signature invalid:\n' + res.body);
  } else if (res.status === 400) {
    console.log('Signature accepted (SES rejected the empty body, as expected). Credentials work.');
  } else {
    console.log('Unexpected status ' + res.status + ':\n' + res.body);
  }
}

/**
 * End-to-end smoke test: send a real message from the first configured domain
 * to the alert address, through the exact path a marked draft would take.
 */
function sendTestEmail() {
  var cfg = getConfig();
  var alias = cfg.defaultLocalpart + '@' + cfg.domains[0];
  var messageId = newMessageId(alias);

  var raw = [
    'From: ' + alias,
    'To: ' + cfg.alertEmail,
    'Subject: Relay smoke test',
    'Message-ID: ' + messageId,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'If this arrived, signing, SES, and the alias are all working.',
  ].join('\r\n');

  var id = sesSendRaw(cfg, alias, { to: [cfg.alertEmail], cc: [], bcc: [] }, raw);
  console.log('SES accepted the test message. SES id: ' + id);
}

/**
 * Report what Gmail actually returns for your marked drafts, without sending
 * anything. Run this when a draft fails to decode — it names the type the API
 * handed back, which is the thing worth knowing and the thing an exception
 * message hides.
 */
function inspectDrafts() {
  var cfg = getConfig();
  var drafts = GmailApp.getDrafts();
  console.log('Found ' + drafts.length + ' draft(s) in total.');

  for (var i = 0; i < drafts.length; i++) {
    var id, subject;
    try {
      id = drafts[i].getId();
      subject = drafts[i].getMessage().getSubject() || '(no subject)';
    } catch (e) {
      console.log('- [unreadable draft] ' + errorText(e));
      continue;
    }

    var token = parseSubjectToken(subject, cfg.domains, cfg.defaultLocalpart, cfg.subjectToken);
    if (!token.marked) continue; // only report what the relay would act on

    var res, raw;
    try {
      res = Gmail.Users.Drafts.get('me', id, { format: 'raw' });
      raw = res && res.message ? res.message.raw : undefined;
    } catch (e) {
      console.log('- "' + subject + '": Drafts.get failed — ' + errorText(e));
      continue;
    }

    // The same probe the decoder's own error path uses, so this diagnostic
    // cannot drift from the code it exists to explain.
    console.log('- "' + subject + '"\n    ' + describeRawPayload(raw));

    try {
      var decoded = fetchRawDraft(id);
      console.log('    decoded OK, ' + decoded.length + ' chars, starts: ' +
        decoded.slice(0, 60).replace(/\r?\n/g, ' | '));
    } catch (e) {
      console.log('    decode FAILED — ' + errorText(e));
    }
  }
}

/**
 * Forget everything the relay knows about past sends.
 *
 * Only for recovering from a wedged state. Clearing the `consumed` bucket makes
 * its drafts eligible again, so anything that already went out would be sent a
 * SECOND time — check your Sent folder before running this.
 *
 * Expressed through loadState/saveState so exactly one place knows the storage
 * shape; an earlier version hard-coded the layout and silently cleared nothing
 * once that layout changed.
 */
function clearRelayState() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();

  var before = loadState(all);
  var counts = [];
  for (var i = 0; i < STATE_BUCKETS.length; i++) {
    var bucket = STATE_BUCKETS[i];
    counts.push(bucket + '=' + Object.keys(before[bucket]).length);
  }
  saveState(props, emptyState());

  // An early version wrote one property per draft ("failed:<id>"), which buried
  // the handful of settings you actually edit. Nothing writes them now, so this
  // sweep only matters for installs that ran that version.
  var legacy = 0;
  for (var key in all) {
    if (all.hasOwnProperty(key) && /^(inflight|consumed|failed):/.test(key)) {
      props.deleteProperty(key);
      legacy++;
    }
  }

  console.log(
    'Cleared relay state (' + counts.join(', ') + ')' +
    (legacy ? ', and removed ' + legacy + ' obsolete per-draft propert(ies)' : '') + '.'
  );
}
