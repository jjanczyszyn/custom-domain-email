# Domain identity verification record.
resource "aws_route53_record" "amazonses_verification" {
  zone_id         = var.zone_id
  name            = "_amazonses.${var.domain}"
  type            = "TXT"
  ttl             = 300
  records         = [aws_ses_domain_identity.this.verification_token]
  allow_overwrite = true
}

# Inbound MX -> SES. allow_overwrite replaces any existing (e.g. forwardemail.net) MX.
# Gated so the cutover only happens once SES is verified and ready (see variable).
resource "aws_route53_record" "mx_inbound" {
  count           = var.enable_mx_cutover ? 1 : 0
  zone_id         = var.zone_id
  name            = var.domain
  type            = "MX"
  ttl             = 300
  records         = ["10 inbound-smtp.${var.region}.amazonaws.com"]
  allow_overwrite = true
}

# DKIM CNAMEs.
resource "aws_route53_record" "dkim" {
  count   = 3
  zone_id = var.zone_id
  name    = "${aws_ses_domain_dkim.this.dkim_tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 300
  records = ["${aws_ses_domain_dkim.this.dkim_tokens[count.index]}.dkim.amazonses.com"]
}

# Custom MAIL FROM records (only when enabled).
resource "aws_route53_record" "mail_from_mx" {
  count   = var.custom_mail_from ? 1 : 0
  zone_id = var.zone_id
  name    = aws_ses_domain_mail_from.this[0].mail_from_domain
  type    = "MX"
  ttl     = 300
  records = ["10 feedback-smtp.${var.region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  count   = var.custom_mail_from ? 1 : 0
  zone_id = var.zone_id
  name    = aws_ses_domain_mail_from.this[0].mail_from_domain
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:amazonses.com ~all"]
}
