output "domain" {
  value = var.domain
}

output "verification_token" {
  value = aws_ses_domain_identity.this.verification_token
}

output "dkim_tokens" {
  value = aws_ses_domain_dkim.this.dkim_tokens
}
