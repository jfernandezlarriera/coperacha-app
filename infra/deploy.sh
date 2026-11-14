#!/usr/bin/env bash
# Creates or updates everything the Coperacha app needs on AWS and deploys the current commit.
#
#   AWS_PROFILE=coperacha AWS_REGION=us-east-2 infra/deploy.sh
#   APPLY_DNS=1 AWS_PROFILE=coperacha infra/deploy.sh    # also upsert the app.coperacha.app records in Route 53
#
# Idempotent: what exists is updated, what is missing is created. Deploying needs JI's OK.
# The script never creates or changes the secret, and prints only names, ARNs and statuses.
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT="355622872251"
REGION="us-east-2"
if [ "${AWS_REGION:-$REGION}" != "$REGION" ]; then
  echo "ERROR: AWS_REGION is ${AWS_REGION}; this app lives in $REGION." >&2; exit 1
fi
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" AWS_PAGER=""

SERVICE="coperacha-app"
SECRET="coperacha-app/prod"
ROLE_INSTANCE="coperacha-app-instance"
ROLE_ECR="coperacha-app-ecr-access"
ASC_NAME="coperacha-app-single"
BUCKET="coperacha-app-data-$ACCOUNT"
DB_KEY="prod/coperacha.json"
DOMAIN="app.coperacha.app"
HOSTED_ZONE="Z07840041NPPNHYPB4RR2"
ECR="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
IMAGE_REPO="$ECR/$SERVICE"

# Keys read from the secret's JSON. Names only: values never pass through this script's output.
SECRET_KEYS_REQUIRED="SESSION_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI ARTURITO_PHONE ARTURITO_SEND_URL ARTURITO_SEND_KEY ARTURITO_WEBHOOK_TOKEN ARTURITO_SEND_LIMIT_PER_MINUTE"
SECRET_KEYS_OPTIONAL="PEY_API_URL PEY_API_KEY PEY_WEBHOOK_SECRET"

die() { echo "ERROR: $*" >&2; exit 1; }
for tool in aws docker git node; do command -v "$tool" >/dev/null || die "$tool is required."; done

# ---------- 0. Right account
CURRENT="$(aws sts get-caller-identity --query Account --output text)"
[ "$CURRENT" = "$ACCOUNT" ] || die "credentials belong to account $CURRENT; expected $ACCOUNT (use AWS_PROFILE=coperacha)."

role_exists() { aws iam get-role --role-name "$1" >/dev/null 2>&1; }
role_arn() { aws iam get-role --role-name "$1" --query Role.Arn --output text; }
service_status() { aws apprunner describe-service --service-arn "$SERVICE_ARN" --query Service.Status --output text; }
wait_running() {
  local status=""
  for _ in $(seq 1 60); do
    status="$(service_status)"
    [ "$status" = "RUNNING" ] && return 0
    case "$status" in CREATE_FAILED|DELETED|DELETE_FAILED) break ;; esac
    sleep 15
  done
  die "App Runner service is $status. Check the service events in the console and run the script again."
}

# ---------- 1. Secret: must already exist (JI loads it separately). Never created or changed here.
SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "$SECRET" --query ARN --output text 2>/dev/null)" \
  || die "secret $SECRET not found in $REGION. Create it first as a JSON object with these keys: $SECRET_KEYS_REQUIRED (optional: $SECRET_KEYS_OPTIONAL). This script does not create it."
echo "Secret: $SECRET_ARN"
# Compare key names only. The value goes straight into node through a pipe and is never printed.
KEY_REPORT="$(aws secretsmanager get-secret-value --secret-id "$SECRET" --query SecretString --output text \
  | REQUIRED="$SECRET_KEYS_REQUIRED" OPTIONAL="$SECRET_KEYS_OPTIONAL" node -e '
      let raw = ""; process.stdin.on("data", (c) => { raw += c; }).on("end", () => {
        let keys;
        try { keys = Object.keys(JSON.parse(raw)); } catch { console.log("INVALID"); return; }
        const missing = process.env.REQUIRED.split(" ").filter((k) => !keys.includes(k));
        const optional = process.env.OPTIONAL.split(" ").filter((k) => keys.includes(k));
        console.log(`MISSING=${missing.join(",")}`); console.log(`OPTIONAL=${optional.join(",")}`);
      });')"
[ "$KEY_REPORT" != "INVALID" ] || die "secret $SECRET is not a JSON object."
MISSING_KEYS="$(echo "$KEY_REPORT" | sed -n 's/^MISSING=//p')"
[ -z "$MISSING_KEYS" ] || die "secret $SECRET is missing keys: $MISSING_KEYS"
OPTIONAL_PRESENT="$(echo "$KEY_REPORT" | sed -n 's/^OPTIONAL=//p' | tr ',' ' ')"

# ---------- 2. ECR repository
aws ecr describe-repositories --repository-names "$SERVICE" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$SERVICE" --image-scanning-configuration scanOnPush=true \
       --image-tag-mutability MUTABLE >/dev/null
REPO_ARN="$(aws ecr describe-repositories --repository-names "$SERVICE" --query 'repositories[0].repositoryArn' --output text)"
echo "ECR: $IMAGE_REPO"

# ---------- 3. Data bucket: private, versioned
if ! aws s3api head-bucket --bucket "$BUCKET" --expected-bucket-owner "$ACCOUNT" >/dev/null 2>&1; then
  aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
fi
aws s3api put-public-access-block --bucket "$BUCKET" --expected-bucket-owner "$ACCOUNT" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$BUCKET" --expected-bucket-owner "$ACCOUNT" --versioning-configuration Status=Enabled
echo "Bucket: $BUCKET (key $DB_KEY, versioning on, public access blocked)"

# ---------- 4. IAM roles (policies in infra/policies/, placeholders filled here)
render() {
  sed -e "s|__SECRET_ARN__|$SECRET_ARN|g" -e "s|__BUCKET__|$BUCKET|g" -e "s|__KEY__|$DB_KEY|g" -e "s|__REPO_ARN__|$REPO_ARN|g" "$1"
}
NEW_ROLES=0
ensure_role() { # name, trust file, inline policy name, policy file
  if role_exists "$1"; then
    aws iam update-assume-role-policy --role-name "$1" --policy-document "file://$2"
  else
    aws iam create-role --role-name "$1" --assume-role-policy-document "file://$2" >/dev/null
    NEW_ROLES=1
  fi
  aws iam put-role-policy --role-name "$1" --policy-name "$3" --policy-document "$(render "$4")"
}
ensure_role "$ROLE_INSTANCE" infra/policies/trust-apprunner-tasks.json instance infra/policies/instance-policy.json
ensure_role "$ROLE_ECR" infra/policies/trust-apprunner-build.json ecr-access infra/policies/ecr-access-policy.json
[ "$NEW_ROLES" = 0 ] || sleep 15   # a new role takes a moment to be usable by App Runner
ROLE_INSTANCE_ARN="$(role_arn "$ROLE_INSTANCE")"; ROLE_ECR_ARN="$(role_arn "$ROLE_ECR")"
echo "Roles: $ROLE_INSTANCE, $ROLE_ECR"

# ---------- 5. Image: build for linux/amd64, push <short sha> and latest
TAG="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  [ "${ALLOW_DIRTY:-0}" = "1" ] || die "working tree has uncommitted changes; commit first (or ALLOW_DIRTY=1 to tag as $TAG-dirty)."
  TAG="$TAG-dirty"
fi
aws ecr get-login-password | docker login --username AWS --password-stdin "$ECR" >/dev/null
docker build --platform linux/amd64 -q -t "$IMAGE_REPO:$TAG" -t "$IMAGE_REPO:latest" . >/dev/null
docker push -q "$IMAGE_REPO:$TAG" >/dev/null
docker push -q "$IMAGE_REPO:latest" >/dev/null
echo "Image: $IMAGE_REPO:$TAG (also latest)"

# ---------- 6. App Runner service
# Exactly one instance: the S3-backed store has a single writer.
ASC_ARN="$(aws apprunner list-auto-scaling-configurations --auto-scaling-configuration-name "$ASC_NAME" --latest-only \
  --query 'AutoScalingConfigurationSummaryList[0].AutoScalingConfigurationArn' --output text)"
if [ -z "$ASC_ARN" ] || [ "$ASC_ARN" = "None" ]; then
  ASC_ARN="$(aws apprunner create-auto-scaling-configuration --auto-scaling-configuration-name "$ASC_NAME" \
    --min-size 1 --max-size 1 --max-concurrency 100 --query AutoScalingConfiguration.AutoScalingConfigurationArn --output text)"
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# Secret references are "<secret ARN>:<JSON key>::"; App Runner resolves them with the instance role.
SECRETS_JSON=""
for key in $SECRET_KEYS_REQUIRED $OPTIONAL_PRESENT; do
  SECRETS_JSON="$SECRETS_JSON${SECRETS_JSON:+,}\"$key\":\"$SECRET_ARN:$key::\""
done
cat > "$TMP/source.json" <<EOF
{
  "ImageRepository": {
    "ImageIdentifier": "$IMAGE_REPO:$TAG",
    "ImageRepositoryType": "ECR",
    "ImageConfiguration": {
      "Port": "3000",
      "RuntimeEnvironmentVariables": {
        "PORT": "3000",
        "APP_BASE_URL": "https://$DOMAIN",
        "COOKIE_SECURE": "true",
        "APP_TIMEZONE": "America/Mexico_City",
        "PEY_MODE": "mock",
        "AUTH_DEV_LOGIN": "false",
        "AWS_REGION": "$REGION",
        "DATABASE_S3_BUCKET": "$BUCKET",
        "DATABASE_S3_KEY": "$DB_KEY"
      },
      "RuntimeEnvironmentSecrets": {$SECRETS_JSON}
    }
  },
  "AutoDeploymentsEnabled": false,
  "AuthenticationConfiguration": {"AccessRoleArn": "$ROLE_ECR_ARN"}
}
EOF
cat > "$TMP/instance.json" <<EOF
{"Cpu": "0.25 vCPU", "Memory": "0.5 GB", "InstanceRoleArn": "$ROLE_INSTANCE_ARN"}
EOF
cat > "$TMP/health.json" <<EOF
{"Protocol": "HTTP", "Path": "/health", "Interval": 10, "Timeout": 5, "HealthyThreshold": 1, "UnhealthyThreshold": 5}
EOF

SERVICE_ARN="$(aws apprunner list-services --query "ServiceSummaryList[?ServiceName=='$SERVICE'].ServiceArn | [0]" --output text)"
if [ -z "$SERVICE_ARN" ] || [ "$SERVICE_ARN" = "None" ]; then
  SERVICE_ARN="$(aws apprunner create-service --service-name "$SERVICE" \
    --source-configuration "file://$TMP/source.json" \
    --instance-configuration "file://$TMP/instance.json" \
    --health-check-configuration "file://$TMP/health.json" \
    --auto-scaling-configuration-arn "$ASC_ARN" --query Service.ServiceArn --output text)"
  echo "App Runner: creating $SERVICE_ARN"
else
  STATUS="$(service_status)"
  case "$STATUS" in
    CREATE_FAILED)
      die "service $SERVICE is in CREATE_FAILED and cannot be updated. Review its events, delete it (aws apprunner delete-service --service-arn $SERVICE_ARN) and run this script again." ;;
    PAUSED)
      aws apprunner resume-service --service-arn "$SERVICE_ARN" >/dev/null; echo "App Runner: resuming…" ;;
    OPERATION_IN_PROGRESS)
      echo "App Runner: another operation is in progress; waiting…" ;;
  esac
  wait_running
  aws apprunner update-service --service-arn "$SERVICE_ARN" \
    --source-configuration "file://$TMP/source.json" \
    --instance-configuration "file://$TMP/instance.json" \
    --health-check-configuration "file://$TMP/health.json" \
    --auto-scaling-configuration-arn "$ASC_ARN" >/dev/null
  echo "App Runner: updating $SERVICE_ARN to $TAG"
fi
echo "App Runner: waiting for RUNNING (a few minutes)…"
wait_running
SERVICE_URL="$(aws apprunner describe-service --service-arn "$SERVICE_ARN" --query Service.ServiceUrl --output text)"
echo "App Runner: RUNNING at https://$SERVICE_URL"

# ---------- 7. Custom domain app.coperacha.app (never the apex)
domain_field() { # JMESPath relative to the custom domain entry
  aws apprunner describe-custom-domains --service-arn "$SERVICE_ARN" \
    --query "CustomDomains[?DomainName=='$DOMAIN'] | [0].$1" --output text
}
if [ "$(domain_field DomainName)" != "$DOMAIN" ]; then
  aws apprunner associate-custom-domain --service-arn "$SERVICE_ARN" --domain-name "$DOMAIN" --no-enable-www-subdomain >/dev/null
  echo "Domain: associating $DOMAIN"
fi
# The certificate validation records show up a little after the association.
RECORDS=""
for _ in $(seq 1 12); do
  RECORDS="$(aws apprunner describe-custom-domains --service-arn "$SERVICE_ARN" \
    --query "CustomDomains[?DomainName=='$DOMAIN'] | [0].CertificateValidationRecords[].[Name,Type,Value]" --output text)"
  [ -n "$RECORDS" ] && [ "$RECORDS" != "None" ] && break
  RECORDS=""; sleep 10
done
DNS_TARGET="$(aws apprunner describe-custom-domains --service-arn "$SERVICE_ARN" --query DNSTarget --output text)"
ALL_RECORDS="$(printf '%s\tCNAME\t%s\n%s\n' "$DOMAIN" "$DNS_TARGET" "$RECORDS" | sed '/^$/d')"

echo
echo "Domain: $DOMAIN is $(domain_field Status)"
echo "DNS records for hosted zone $HOSTED_ZONE (name, type, value):"
echo "$ALL_RECORDS" | sed 's/^/  /'
[ -n "$RECORDS" ] || echo "  (certificate validation records not available yet; run the script again in a minute)"

if [ "${APPLY_DNS:-0}" = "1" ]; then
  CHANGES=""
  while IFS=$'\t' read -r name type value; do
    [ -n "$name" ] || continue
    bare="${name%.}"
    # Only app.coperacha.app and names under it; the apex and every other record stay untouched.
    case "$bare" in "$DOMAIN"|*".$DOMAIN") ;; *) die "refusing to write DNS record $bare: outside $DOMAIN." ;; esac
    [ "$type" = "CNAME" ] || die "unexpected record type $type for $bare."
    CHANGES="$CHANGES${CHANGES:+,}{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$bare\",\"Type\":\"CNAME\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$value\"}]}}"
  done <<< "$ALL_RECORDS"
  echo "{\"Comment\":\"coperacha-app custom domain\",\"Changes\":[$CHANGES]}" > "$TMP/dns.json"
  aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE" --change-batch "file://$TMP/dns.json" \
    --query ChangeInfo.Status --output text | sed 's/^/Route 53: /'
else
  echo "Add them by hand, or run again with APPLY_DNS=1 to upsert exactly these records."
fi

cat <<EOF

Done.
  Service:  $SERVICE ($SERVICE_ARN)
  Image:    $IMAGE_REPO:$TAG
  URL:      https://$SERVICE_URL  ->  https://$DOMAIN once DNS validates
  Health:   https://$SERVICE_URL/health
  Secret:   $SECRET (read only by the instance role; not modified)
  Store:    s3://$BUCKET/$DB_KEY
EOF
