variable "domain" { type = string }
variable "zone_id" { type = string }
variable "region" { type = string }
variable "account_id" { type = string }
variable "rule_set_name" { type = string }
variable "bucket_id" { type = string }
variable "s3_prefix" { type = string }
variable "lambda_arn" { type = string }

variable "custom_mail_from" {
  description = "Set a bounce.<domain> MAIL FROM. Leave false if the domain already sends via SES/Resend."
  type        = bool
  default     = false
}

variable "enable_mx_cutover" {
  description = <<-EOT
    Flip the domain's inbound MX to SES. Keep false until SES has verified the
    domain identity AND the forward destinations, so no mail is lost in the gap.
    Phase 1 (false): stand everything up. Phase 2 (true): cut over.
  EOT
  type        = bool
  default     = false
}
