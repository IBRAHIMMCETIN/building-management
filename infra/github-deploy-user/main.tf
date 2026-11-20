# ---------------------------------------------------------------------------
# CI dagitim kullanicisi (github-deploy) icin en az yetkili politika.
#
# Hesaptaki SCP OIDC saglayicisi olusturmayi engelledigi icin CI, GitHub secret'larindaki
# github-deploy erisim anahtariyla calisir. Bu yigin o kullaniciya serverless yigini dagitmaya
# YETEN kadar yetki verir (politika: infra/modules/deploy-policy, github-oidc ile ortak).
#
# Kullanici bu yiginca OLUSTURULMAZ (zaten var, anahtari GitHub'da). Bir kez, yonetici
# kimlik bilgileriyle elle uygulanir:
#
#   terraform -chdir=infra/github-deploy-user init \
#     -backend-config="bucket=building-management-tfstate-<hesap>-eu-north-1" \
#     -backend-config="key=github-deploy-user/terraform.tfstate" \
#     -backend-config="region=eu-north-1" -backend-config="use_lockfile=true"
#   terraform -chdir=infra/github-deploy-user apply
#
# Sonra kullaniciya onceden bagli GENIS politikalar (ornegin AdministratorAccess) elle
# kaldirilir ve CI'da dev dagitimi (workflow_dispatch target=dev) ile dogrulanir. Eksik yetki
# cikarsa politika modulune eklenir; gecici olarak eski politika geri baglanabilir.
#
# IAM kullanicisina gomulu (inline) politika 2.048 karakterle sinirli; bu politika daha buyuk
# oldugu icin yonetilen (managed) politika olarak olusturulup baglanir (sinir 6.144).
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {}
}

variable "aws_region" {
  type        = string
  default     = "eu-north-1"
  description = "Projenin bolgesi (IAM global olsa da saglayici bir bolge ister; SCP diger bolgeleri reddeder)."
}

variable "user_name" {
  type        = string
  default     = "github-deploy"
  description = "CI'in kullandigi IAM kullanicisi (GitHub secret AWS_ACCESS_KEY_ID'nin sahibi)."
}

variable "project" {
  type    = string
  default = "building-management"
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Stack     = "github-deploy-user"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

# Kullanici yoksa plan burada hata verir (yanlis hesap/ad korumasi).
data "aws_iam_user" "deploy" {
  user_name = var.user_name
}

module "deploy_policy" {
  source     = "../modules/deploy-policy"
  project    = var.project
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
}

resource "aws_iam_policy" "deploy" {
  name        = "${var.project}-serverless-deploy"
  description = "CI: serverless yigini (infra/*.tf) dagitmak icin en az yetki. Kaynak: infra/modules/deploy-policy"
  policy      = module.deploy_policy.json
}

resource "aws_iam_user_policy_attachment" "deploy" {
  user       = data.aws_iam_user.deploy.user_name
  policy_arn = aws_iam_policy.deploy.arn
}

output "policy_arn" {
  value = aws_iam_policy.deploy.arn
}

# SCP iam:CreatePolicy'yi de engellerse: bu JSON konsoldan elle olusturulup baglanabilir.
output "policy_json" {
  value = module.deploy_policy.json
}
