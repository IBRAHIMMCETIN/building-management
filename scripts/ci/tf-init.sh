#!/usr/bin/env bash
# Terraform'u hedef ortamin state'ine baglar ve ortama ozel degiskenleri sonraki adimlar
# icin GITHUB_ENV'e yazar. serverless-deploy.yml'deki plan ve deploy isleri kullanir.
#
#   bash scripts/ci/tf-init.sh <dev|prod>
#
# Gerekli: AWS kimlik bilgisi, AWS_REGION (detect-aws-region.sh), GITHUB_ENV.
# Opsiyonel: TF_DIR (varsayilan infra).
# Ortam ayarlari (CORS, Cognito katmani, MFA, odeme, alan adi...) dev.tfvars / prod.tfvars'ta.
# -var-file degerleri TF_VAR_* degiskenlerini ezer; ALERT_EMAIL / SES_* bu yuzden tfvars'ta yok.
#
# dev ve prod state'leri ayri key'lerdedir (serverless-dev/ ve serverless/). Ikisini asla
# karistirmayin: dev'de environment dev.tfvars'tan, prod'da TF_VAR_environment'tan gelir.
set -euo pipefail

target="${1:?hedef ortam verilmeli: dev | prod}"
tf_dir="${TF_DIR:-infra}"

case "$target" in
  dev)
    # Backend ayarlari (bucket, key=serverless-dev/terraform.tfstate) repodaki dosyada.
    terraform -chdir="$tf_dir" init -input=false -backend-config=dev.s3.tfbackend
    # Ortam adi, CORS listesi, silme korumasi vb. dev.tfvars'tan; her plan'a otomatik eklenir.
    echo "TF_CLI_ARGS_plan=-var-file=dev.tfvars" >> "$GITHUB_ENV"
    ;;

  prod)
    account_id=$(aws sts get-caller-identity --query Account --output text)
    bucket="building-management-tfstate-${account_id}-${AWS_REGION}"
    if ! aws s3api head-bucket --bucket "$bucket" 2>/dev/null; then
      echo "State bucket olusturuluyor: $bucket"
      if [ "$AWS_REGION" = "us-east-1" ]; then
        aws s3api create-bucket --bucket "$bucket"
      else
        aws s3api create-bucket --bucket "$bucket" --create-bucket-configuration "LocationConstraint=$AWS_REGION"
      fi
      aws s3api put-bucket-versioning --bucket "$bucket" --versioning-configuration Status=Enabled
      aws s3api put-public-access-block --bucket "$bucket" \
        --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    fi
    terraform -chdir="$tf_dir" init -input=false \
      -backend-config="bucket=$bucket" \
      -backend-config="key=serverless/terraform.tfstate" \
      -backend-config="region=$AWS_REGION" \
      -backend-config="use_lockfile=true"
    # Prod ayarlari repodaki prod.tfvars'tan (production_guardrails dahil); her plan'a eklenir.
    # Eski PROD_CORS_ALLOW_ORIGINS / PROD_COGNITO_USER_POOL_TIER repo degiskenleri artik
    # kullanilmaz (localhost'a dusen sessiz varsayilan kaldirildi).
    {
      echo "TF_VAR_environment=prod"
      echo "TF_CLI_ARGS_plan=-var-file=prod.tfvars"
    } >> "$GITHUB_ENV"
    ;;

  *)
    echo "::error::Bilinmeyen hedef ortam: $target (dev | prod)"
    exit 1
    ;;
esac

echo "Terraform hedefi: $target"
