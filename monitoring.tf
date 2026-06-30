# ── Alerts topic (email) ─────────────────────────────────────────────────────
resource "aws_sns_topic" "alerts" {
  name = "${var.project}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
  # NOTE: confirm the subscription via the email AWS sends after the first apply.
}

# ── Forwarder failure alarms ─────────────────────────────────────────────────
resource "aws_cloudwatch_metric_alarm" "forwarder_errors" {
  alarm_name          = "${var.project}-forwarder-errors"
  alarm_description   = "The email forwarder Lambda threw errors (mail may not be forwarded)."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.forwarder.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "forwarder_throttles" {
  alarm_name          = "${var.project}-forwarder-throttles"
  alarm_description   = "The email forwarder Lambda is being throttled."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.forwarder.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# ── Dead-letter alarm: a forward failed every retry and was captured ─────────
# Pairs with the on-failure SQS queue. Any message here is an email that could
# not be forwarded; the alarm tells you to inspect/replay it (the raw is still
# in S3). Fires on the count of messages ever sent to the queue, so it trips
# even if the message is later consumed.
resource "aws_cloudwatch_metric_alarm" "forwarder_dlq" {
  alarm_name          = "${var.project}-forwarder-dlq"
  alarm_description   = "A forwarded email failed all retries and landed in the dead-letter queue."
  namespace           = "AWS/SQS"
  metric_name         = "NumberOfMessagesSent"
  dimensions          = { QueueName = aws_sqs_queue.forwarder_dlq.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# ── Heartbeat: alarm if the end-to-end pipeline goes silent ──────────────────
# The canary sends a probe every canary_rate; the forwarder records
# CanaryHeartbeat when it arrives. Missing data = the pipeline broke
# (MX changed, receipt rule disabled, Lambda down) -> alarm.
resource "aws_cloudwatch_metric_alarm" "heartbeat_missing" {
  alarm_name          = "${var.project}-heartbeat-missing"
  alarm_description   = "No inbound-pipeline heartbeat received. Forwarding may be down."
  namespace           = var.metric_namespace
  metric_name         = "CanaryHeartbeat"
  statistic           = "Sum"
  period              = var.heartbeat_window_seconds
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# ── Canary Lambda + schedule ─────────────────────────────────────────────────
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
      { Sid = "SendProbe", Effect = "Allow", Action = ["ses:SendEmail"], Resource = "*" },
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
      FROM_ADDRESS  = "${var.from_localpart}@${local.canary_domain}"
      PROBE_ADDRESS = "${var.probe_localpart}@${local.canary_domain}"
    }
  }

  depends_on = [aws_cloudwatch_log_group.canary]
}

resource "aws_cloudwatch_event_rule" "canary" {
  name                = "${var.project}-canary"
  description         = "Triggers the email pipeline heartbeat."
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
