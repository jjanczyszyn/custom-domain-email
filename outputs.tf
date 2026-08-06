output "covered_domains" {
  description = "Domains this stack forwards mail for."
  value       = keys(local.domains)
}

output "forward_mapping" {
  description = "Effective recipient -> destination routing."
  value       = local.forward_mapping
}

output "smtp_endpoint" {
  description = "SMTP server for Gmail > Send mail as."
  value       = "email-smtp.${var.region}.amazonaws.com"
}

output "smtp_username" {
  value = aws_iam_access_key.smtp.id
}

output "smtp_password" {
  description = "Run: terraform output -raw smtp_password"
  value       = aws_iam_access_key.smtp.ses_smtp_password_v4
  sensitive   = true
}

output "relay_access_key_id" {
  description = "AWS_ACCESS_KEY_ID for the Apps Script relay's Script Properties."
  value       = aws_iam_access_key.relay.id
}

output "relay_secret_access_key" {
  description = "Run: terraform output -raw relay_secret_access_key"
  value       = aws_iam_access_key.relay.secret
  sensitive   = true
}
