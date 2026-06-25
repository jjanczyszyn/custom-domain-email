terraform {
  required_version = ">= 1.5"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.0" }
  }
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}

locals {
  config  = yamldecode(file("${path.module}/config/domains.yaml"))
  domains = local.config.domains

  # Flat recipient -> destinations map for the forwarder Lambda.
  # "@<domain>" is the catch-all; "<alias>@<domain>" overrides a single mailbox.
  forward_mapping = merge(flatten([
    for domain, cfg in local.domains : [
      { "@${domain}" = cfg.forward_to },
      { for alias, dests in try(cfg.aliases, {}) : "${alias}@${domain}" => dests },
    ]
  ])...)

  # Every destination must be a verified SES identity while in the sandbox.
  verified_destinations = distinct(flatten([
    for cfg in values(local.domains) :
    concat(cfg.forward_to, flatten(values(try(cfg.aliases, {}))))
  ]))

  # The heartbeat probe is sent to/from the first configured domain.
  canary_domain = keys(local.domains)[0]
}
