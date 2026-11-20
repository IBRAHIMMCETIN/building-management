# ---------------------------------------------------------------------------
# GitHub Actions -> AWS OIDC (uzun omurlu erisim anahtari olmadan dagitim).
#
# Bu yigin BIR KEZ, yonetici kimlik bilgileriyle elle uygulanir (tavuk-yumurta: CI'in
# kullanacagi rolu CI olusturamaz):
#
#   cd infra/github-oidc
#   terraform init -backend-config="bucket=building-management-tfstate-<hesap>-<region>" \
#                  -backend-config="key=github-oidc/terraform.tfstate" \
#                  -backend-config="region=<region>" -backend-config="use_lockfile=true"
#   terraform apply -var="github_repository=IBRAHIMMCETIN/building-management"
#
# Repo tasinirsa (owner/ad degisirse) ayni komutla yeni deger verilerek yeniden uygulanir;
# trust policy eski repoya ait token'lari artik kabul etmez.
#
# Ciktidaki `deploy_role_arn` degerini GitHub'da repo variable AWS_DEPLOY_ROLE_ARN olarak
# kaydedin. Workflow bu degiskeni gorurse OIDC, gormezse AWS_ACCESS_KEY_ID/SECRET kullanir.
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

provider "aws" {
  default_tags {
    tags = {
      Project   = "building-management"
      ManagedBy = "terraform"
      Stack     = "github-oidc"
    }
  }
}

variable "github_repository" {
  type        = string
  description = "owner/repo, ornegin ibrahimcetin/building-management"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "owner/repo biciminde olmalidir."
  }
}

variable "create_oidc_provider" {
  type        = bool
  default     = true
  description = "Hesapta token.actions.githubusercontent.com saglayicisi zaten varsa false yapin."
}

variable "project" {
  type    = string
  default = "building-management"
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account   = data.aws_caller_identity.current.account_id
  partition = data.aws_partition.current.partition
  oidc_host = "token.actions.githubusercontent.com"
  repo      = var.github_repository
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_oidc_provider ? 1 : 0
  url            = "https://${local.oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1
  url   = "https://${local.oidc_host}"
}

locals {
  oidc_provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

# Yalnizca bu repo ve serverless-deploy.yml'deki isler rolu ustlenebilir:
#   - environment: dev        -> main'e push (dev apply) / workflow_dispatch target=dev
#   - environment: production -> v* etiketi / workflow_dispatch target=prod
#   - pull_request            -> PR'larda dev'e karsi salt-okunur plan
# Dal bazli (ref:refs/heads/...) ustlenme kaldirildi: apply yapan her is bir environment
# kullanir, boylece GitHub'daki environment koruma kurallari (onayci, dal kisiti) devreye girer.
data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "${local.oidc_host}:sub"
      values = [
        "repo:${local.repo}:environment:production",
        "repo:${local.repo}:environment:dev",
        "repo:${local.repo}:pull_request",
      ]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.project}-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

module "deploy_policy" {
  source     = "../modules/deploy-policy"
  project    = var.project
  account_id = local.account
  partition  = local.partition
}

resource "aws_iam_role_policy" "deploy" {
  name   = "serverless-deploy"
  role   = aws_iam_role.deploy.id
  policy = module.deploy_policy.json
}

output "deploy_role_arn" {
  description = "GitHub repo variable AWS_DEPLOY_ROLE_ARN olarak kaydedin."
  value       = aws_iam_role.deploy.arn
}
