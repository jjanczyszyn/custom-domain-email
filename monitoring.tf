# ── Failure notifications by email (no CloudWatch alarms) ────────────────────
# There are deliberately no CloudWatch alarms or SNS topics. Every failure
# instead becomes a plain email in the inbox, so mail always shows up in some
# form and you know to poke the pipeline:
#   * A forward that fails all retries lands in the DLQ; the notifier Lambda
#     turns it into a summary email (who it was from, subject, why it failed,
#     where the original is in S3).
#   * The canary doubles as a watchdog that emails directly when the whole
#     inbound pipeline goes silent — the one failure no in-pipeline email can
#     report, because nothing reaches the forwarder to trigger it.

# ── DLQ notifier: dead-lettered forwards become a plain email ────────────────
data "archive_file" "notifier" {
  type        = "zip"
  source_dir  = "${path.module}/notifier"
  output_path = "${path.module}/.build/notifier.zip"
}

resource "aws_iam_role" "notifier" {
  name = "${var.project}-notifier"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "notifier" {
  name = "permissions"
  role = aws_iam_role.notifier.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:*" },
      { Sid = "ConsumeDLQ", Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = aws_sqs_queue.forwarder_dlq.arn },
      { Sid = "SendNotice", Effect = "Allow", Action = ["ses:SendEmail"], Resource = "*" },
    ]
  })
}

resource "aws_cloudwatch_log_group" "notifier" {
  name              = "/aws/lambda/${var.project}-notifier"
  retention_in_days = 30
}

resource "aws_lambda_function" "notifier" {
  function_name    = "${var.project}-notifier"
  role             = aws_iam_role.notifier.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.notifier.output_path
  source_code_hash = data.archive_file.notifier.output_base64sha256
  timeout          = 30

  environment {
    variables = {
      FROM_ADDRESS = "${var.from_localpart}@${local.canary_domain}"
      ALERT_EMAIL  = var.alert_email
      S3_BUCKET    = aws_s3_bucket.inbound.id
      S3_PREFIX    = "inbound/"
    }
  }

  depends_on = [aws_cloudwatch_log_group.notifier]
}

# Drain the DLQ into the notifier: one email per dead-lettered forward.
resource "aws_lambda_event_source_mapping" "notifier_dlq" {
  event_source_arn = aws_sqs_queue.forwarder_dlq.arn
  function_name    = aws_lambda_function.notifier.arn
  batch_size       = 1
  enabled          = true
}

# ── Canary: heartbeat + silent-pipeline watchdog ─────────────────────────────
data "archive_file" "canary" {
  type        = "zip"
  source_dir  = "${path.module}/canary"
  output_path = "${path.module}/.build/canary.zip"
}

resource "aws_iam_role" "canary" {
  name = "${var.project}-canary"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "canary" {
  name = "permissions"
  role = aws_iam_role.canary.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:*" },
      { Sid = "SendProbeAndAlert", Effect = "Allow", Action = ["ses:SendEmail"], Resource = "*" },
      { Sid = "ReadHeartbeat", Effect = "Allow", Action = ["cloudwatch:GetMetricStatistics"], Resource = "*" },
    ]
  })
}

resource "aws_cloudwatch_log_group" "canary" {
  name              = "/aws/lambda/${var.project}-canary"
  retention_in_days = 30
}

resource "aws_lambda_function" "canary" {
  function_name    = "${var.project}-canary"
  role             = aws_iam_role.canary.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.canary.output_path
  source_code_hash = data.archive_file.canary.output_base64sha256
  timeout          = 15

  environment {
    variables = {
      FROM_ADDRESS             = "${var.from_localpart}@${local.canary_domain}"
      PROBE_ADDRESS            = "${var.probe_localpart}@${local.canary_domain}"
      ALERT_EMAIL              = var.alert_email
      METRIC_NAMESPACE         = var.metric_namespace
      HEARTBEAT_WINDOW_SECONDS = tostring(var.heartbeat_window_seconds)
    }
  }

  depends_on = [aws_cloudwatch_log_group.canary]
}

resource "aws_cloudwatch_event_rule" "canary" {
  name                = "${var.project}-canary"
  description         = "Triggers the email pipeline heartbeat + silent-pipeline watchdog."
  schedule_expression = var.canary_rate
}

resource "aws_cloudwatch_event_target" "canary" {
  rule      = aws_cloudwatch_event_rule.canary.name
  target_id = "canary"
  arn       = aws_lambda_function.canary.arn
}

resource "aws_lambda_permission" "canary_events" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.canary.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.canary.arn
}
