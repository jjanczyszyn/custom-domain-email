variable "region" {
  description = "AWS region. Must support SES inbound (us-east-1, us-west-2, eu-west-1)."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Name prefix for shared resources (bucket, lambda, IAM user)."
  type        = string
  default     = "multi-domain-email"
}

variable "from_localpart" {
  description = "Local part of the address forwarded mail is sent FROM (e.g. no-reply@<domain>). Original sender is kept in Reply-To."
  type        = string
  default     = "no-reply"
}

variable "enable_mx_cutover" {
  description = "Phase 2 switch: flip all domains' inbound MX to SES. Keep false until SES identities + destinations are verified."
  type        = bool
  default     = false
}

variable "inbound_retention_days" {
  description = "Days to keep raw inbound emails in S3 before automatic deletion."
  type        = number
  default     = 30
}

variable "alert_email" {
  description = "Address that receives CloudWatch alarm notifications. Set via .env (TF_VAR_alert_email). Confirm the SNS subscription email once."
  type        = string
}

variable "probe_localpart" {
  description = "Local part the heartbeat canary sends to; the forwarder records a metric instead of forwarding it."
  type        = string
  default     = "probe"
}

variable "metric_namespace" {
  description = "CloudWatch namespace for the heartbeat metric."
  type        = string
  default     = "EmailForwarder"
}

variable "canary_rate" {
  description = "EventBridge schedule expression for the heartbeat."
  type        = string
  default     = "rate(1 hour)"
}

variable "heartbeat_window_seconds" {
  description = "Alarm if no heartbeat is recorded within this window. Should comfortably exceed canary_rate."
  type        = number
  default     = 7200
}
