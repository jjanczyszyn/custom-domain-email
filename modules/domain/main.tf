# Domain identity + DKIM so the forwarder can send signed mail from @domain.
resource "aws_ses_domain_identity" "this" {
  domain = var.domain
}

resource "aws_ses_domain_dkim" "this" {
  domain = aws_ses_domain_identity.this.domain
}

# Optional custom MAIL FROM (off by default to avoid disturbing existing sending).
resource "aws_ses_domain_mail_from" "this" {
  count                  = var.custom_mail_from ? 1 : 0
  domain                 = aws_ses_domain_identity.this.domain
  mail_from_domain       = "bounce.${var.domain}"
  behavior_on_mx_failure = "UseDefaultValue"
}

# Receipt rule: store raw mail to S3, then invoke the shared forwarder Lambda.
resource "aws_ses_receipt_rule" "forward" {
  name          = "forward-${var.domain}"
  rule_set_name = var.rule_set_name
  recipients    = [var.domain]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Require"

  s3_action {
    bucket_name       = var.bucket_id
    object_key_prefix = var.s3_prefix
    position          = 1
  }

  lambda_action {
    function_arn    = var.lambda_arn
    invocation_type = "Event"
    position        = 2
  }
}
