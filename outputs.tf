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
