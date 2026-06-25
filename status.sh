#!/usr/bin/env bash
# Show SES verification status for every configured domain + destination.
# When everything reads "Success" / verified, it is safe to run ./deploy.sh --cutover
set -euo pipefail
cd "$(dirname "$0")"
REGION="${AWS_REGION:-us-east-1}"

DOMAINS=$(python3 -c "import yaml;print(' '.join(yaml.safe_load(open('config/domains.yaml'))['domains']))" 2>/dev/null \
  || grep -E '^  [a-z0-9.-]+:' config/domains.yaml | tr -d ' :')

echo "== Domain identity (must be Success before cutover) =="
for d in $DOMAINS; do
  s=$(aws ses get-identity-verification-attributes --identities "$d" --region "$REGION" \
       --query "VerificationAttributes.\"$d\".VerificationStatus" --output text 2>/dev/null)
  k=$(aws ses get-identity-dkim-attributes --identities "$d" --region "$REGION" \
       --query "DkimAttributes.\"$d\".DkimVerificationStatus" --output text 2>/dev/null)
  printf "  %-22s identity=%-10s dkim=%s\n" "$d" "${s:-?}" "${k:-?}"
done

echo "== Forward destinations (must be Success while in the sandbox) =="
for e in $(python3 -c "import yaml;c=yaml.safe_load(open('config/domains.yaml'))['domains'];print(' '.join({x for v in c.values() for x in v['forward_to']}))" 2>/dev/null); do
  s=$(aws ses get-identity-verification-attributes --identities "$e" --region "$REGION" \
       --query "VerificationAttributes.\"$e\".VerificationStatus" --output text 2>/dev/null)
  printf "  %-40s %s\n" "$e" "${s:-Pending (click the email)}"
done
