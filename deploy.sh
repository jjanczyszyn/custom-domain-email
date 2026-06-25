#!/usr/bin/env bash
# Deploy the email-forwarding stack. Copy config/domains.example.yaml to
# config/domains.yaml and .env.example to .env first.
#
# Two-phase rollout (avoids losing mail during the MX switch):
#   ./deploy.sh            Phase 1: stand everything up, MX NOT yet switched.
#   ./deploy.sh --cutover  Phase 2: flip MX to SES (run after verification).
set -euo pipefail
cd "$(dirname "$0")"

# Load personal settings (TF_VAR_*) if present.
[[ -f .env ]] && set -a && . ./.env && set +a

CUTOVER=false
[[ "${1:-}" == "--cutover" ]] && CUTOVER=true

terraform init -input=false
terraform apply -var "enable_mx_cutover=${CUTOVER}"

if [[ "$CUTOVER" == false ]]; then
  cat <<'EOT'

Phase 1 done. Before cutting over MX:
  1. Click the SES verification link emailed to each forward destination.
  2. Wait for SES to verify the domains (DKIM/DNS); check with ./status.sh
  3. When all show verified, run:  ./deploy.sh --cutover
EOT
else
  cat <<'EOT'

Cutover complete. Inbound mail now flows through SES.
  - Test: email an address on each domain; confirm it lands in Gmail.
  - Gmail "Send mail as" creds:
      terraform output smtp_endpoint
      terraform output -raw smtp_username
      terraform output -raw smtp_password
  - To reply to ANY recipient (leave the SES sandbox), request production access:
      https://console.aws.amazon.com/ses/home?region=us-east-1#/account
EOT
fi
