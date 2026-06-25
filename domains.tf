# Zone lookups done at the root (no depends_on here) so zone_id is known at plan
# time. Keeping it inside the module would defer it and spuriously force-replace
# every DNS record.
data "aws_route53_zone" "domains" {
  for_each     = local.domains
  name         = "${each.key}."
  private_zone = false
}

# One module instance per domain in config/domains.yaml.
module "domain" {
  source   = "./modules/domain"
  for_each = local.domains

  domain            = each.key
  zone_id           = data.aws_route53_zone.domains[each.key].zone_id
  region            = var.region
  account_id        = data.aws_caller_identity.current.account_id
  rule_set_name     = aws_ses_receipt_rule_set.main.rule_set_name
  bucket_id         = aws_s3_bucket.inbound.id
  s3_prefix         = "inbound/"
  lambda_arn        = aws_lambda_function.forwarder.arn
  custom_mail_from  = try(each.value.custom_mail_from, false)
  enable_mx_cutover = var.enable_mx_cutover

  depends_on = [
    aws_s3_bucket_policy.inbound,
    aws_lambda_permission.allow_ses,
  ]
}
