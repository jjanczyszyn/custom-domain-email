/**
 * config.gs — configuration, read from Script Properties.
 *
 * Nothing secret or personal is committed. Credentials, domains, and the alert
 * address all live in Script Properties, which is this project's equivalent of
 * the gitignored config/domains.yaml and .env used by the Terraform side.
 * setup.gs writes them; this file reads and validates them.
 */

// Every alert the pipeline sends — from here, the DLQ notifier, or the canary —
// starts with this, so one Gmail filter on the phrase catches all of them.
// Keep it in step with ALERT_PREFIX in notifier/ and canary/.
var ALERT_SUBJECT_PREFIX = '[SES alert]';

var LABEL_OUTBOX = 'SES/Outbox';
var LABEL_FAILED = 'SES/Failed';
var LABEL_REVIEW = 'SES/Needs-Review';
var LABEL_FROM_PREFIX = 'SES/from:';

// Property keys. See appsscript/README.md for what each one holds.
var PROP_ACCESS_KEY = 'AWS_ACCESS_KEY_ID';
var PROP_SECRET_KEY = 'AWS_SECRET_ACCESS_KEY';
var PROP_REGION = 'AWS_REGION';
var PROP_DOMAINS = 'DOMAINS';
var PROP_DEFAULT_LOCALPART = 'DEFAULT_LOCALPART';
var PROP_ALERT_EMAIL = 'ALERT_EMAIL';
var PROP_METRIC_NAMESPACE = 'METRIC_NAMESPACE';
var PROP_SETTLE_SECONDS = 'SETTLE_SECONDS';
var PROP_STALE_MINUTES = 'STALE_MINUTES';
var PROP_SUBJECT_TOKEN = 'SUBJECT_TOKEN';

/** Read and validate configuration. Throws with a useful message if unusable. */
function getConfig() {
  var props = PropertiesService.getScriptProperties();
  var get = function (key, fallback) {
    var v = props.getProperty(key);
    return v === null || v === '' ? fallback : v;
  };

  var cfg = {
    accessKey: get(PROP_ACCESS_KEY, ''),
    secretKey: get(PROP_SECRET_KEY, ''),
    region: get(PROP_REGION, 'us-east-1'),
    domains: get(PROP_DOMAINS, '')
      .split(',')
      .map(function (d) { return d.trim(); })
      .filter(function (d) { return d.length > 0; }),
    defaultLocalpart: get(PROP_DEFAULT_LOCALPART, 'hello'),
    alertEmail: get(PROP_ALERT_EMAIL, ''),
    metricNamespace: get(PROP_METRIC_NAMESPACE, 'EmailForwarder'),
    settleSeconds: parseInt(get(PROP_SETTLE_SECONDS, '45'), 10),
    staleMinutes: parseInt(get(PROP_STALE_MINUTES, '15'), 10),

    // Set the SUBJECT_TOKEN property to an empty string to switch the subject
    // marker off, making the SES/Outbox label the only way to send. Note the
    // deliberate use of getProperty directly: `get()` treats '' as unset and
    // would hand back the default, which is exactly the opposite of intent.
    subjectToken:
      props.getProperty(PROP_SUBJECT_TOKEN) === null
        ? DEFAULT_SUBJECT_TOKEN
        : props.getProperty(PROP_SUBJECT_TOKEN),
  };

  var missing = [];
  if (!cfg.accessKey) missing.push(PROP_ACCESS_KEY);
  if (!cfg.secretKey) missing.push(PROP_SECRET_KEY);
  if (!cfg.domains.length) missing.push(PROP_DOMAINS);
  if (!cfg.alertEmail) missing.push(PROP_ALERT_EMAIL);
  if (missing.length) {
    throw new Error(
      'Missing Script Properties: ' + missing.join(', ') + '. Run setUp() first.'
    );
  }

  return cfg;
}
