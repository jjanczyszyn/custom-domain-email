# ── Shared resources used by every domain ────────────────────────────────────

# Raw inbound emails land here; the forwarder reads them. Auto-expire.
resource "aws_s3_bucket" "inbound" {
  bucket = "${var.project}-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "inbound" {
  bucket                  = aws_s3_bucket.inbound.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  rule {
    id     = "expire-raw-email"
    status = "Enabled"
    filter { prefix = "inbound/" }
    expiration { days = var.inbound_retention_days }
  }
}

resource "aws_s3_bucket_policy" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSESPuts"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "s3:PutObject"
      Resource  = "${aws_s3_bucket.inbound.arn}/*"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}

# ── Forwarder Lambda (shared across all domains) ─────────────────────────────
data "archive_file" "forwarder" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/src"
  output_path = "${path.module}/.build/forwarder.zip"
}

resource "aws_iam_role" "forwarder" {
  name = "${var.project}-forwarder"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "forwarder" {
  name = "permissions"
  role = aws_iam_role.forwarder.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:*" },
      { Sid = "ReadInbox", Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.inbound.arn}/*" },
      { Sid = "SendForwarded", Effect = "Allow", Action = ["ses:SendRawEmail"], Resource = "*" },
      { Sid = "Heartbeat", Effect = "Allow", Action = ["cloudwatch:PutMetricData"], Resource = "*" },
    ]
  })
}

# Explicit log group with retention (otherwise logs are kept forever).
resource "aws_cloudwatch_log_group" "forwarder" {
  name              = "/aws/lambda/${var.project}-forwarder"
  retention_in_days = 30
}

resource "aws_lambda_function" "forwarder" {
  function_name    = "${var.project}-forwarder"
  role             = aws_iam_role.forwarder.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.forwarder.output_path
  source_code_hash = data.archive_file.forwarder.output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      MAPPING_JSON     = jsonencode(local.forward_mapping)
      FROM_LOCALPART   = var.from_localpart
      PROBE_LOCALPART  = var.probe_localpart
      METRIC_NAMESPACE = var.metric_namespace
      S3_BUCKET        = aws_s3_bucket.inbound.id
      S3_PREFIX        = "inbound/"
    }
  }

  depends_on = [aws_cloudwatch_log_group.forwarder]
}

resource "aws_lambda_permission" "allow_ses" {
  statement_id   = "AllowSESInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.forwarder.function_name
  principal      = "ses.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}

# ── Shared receipt rule set (one rule per domain, added by the module) ───────
resource "aws_ses_receipt_rule_set" "main" {
  rule_set_name = "${var.project}-inbound"
}

resource "aws_ses_active_receipt_rule_set" "main" {
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
}

# ── Verified destination identities (required while SES is in the sandbox) ───
resource "aws_ses_email_identity" "destinations" {
  for_each = toset(local.verified_destinations)
  email    = each.value
}

# ── SES SMTP user for Gmail "Send mail as" (one set of creds, all domains) ───
resource "aws_iam_user" "smtp" {
  name = "${var.project}-smtp"
}

resource "aws_iam_user_policy" "smtp" {
  name = "ses-send"
  user = aws_iam_user.smtp.name
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["ses:SendRawEmail"], Resource = "*" }]
  })
}

resource "aws_iam_access_key" "smtp" {
  user = aws_iam_user.smtp.name
}
