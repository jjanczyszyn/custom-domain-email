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
      'Mark a draft with the "' + LABEL_OUTBOX + '" label or a ">>" subject ' +
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
  var messageId = '<' + Utilities.getUuid() + '@' + cfg.domains[0] + '>';

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
 * Clear every in-flight and consumed marker.
 *
 * Only for recovering from a wedged state during setup. Clearing a consumed
 * marker makes its draft eligible again, so a draft that already went out
 * would be sent a second time — check Sent before running this.
 */
function resetMarkers() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var cleared = 0;
  for (var key in all) {
    if (!all.hasOwnProperty(key)) continue;
    if (key.indexOf(PROP_INFLIGHT_PREFIX) === 0 || key.indexOf(PROP_CONSUMED_PREFIX) === 0) {
      props.deleteProperty(key);
      cleared++;
    }
  }
  console.log('Cleared ' + cleared + ' marker(s).');
}
