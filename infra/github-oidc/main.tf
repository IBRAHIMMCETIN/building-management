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

# Serverless yiginin (infra/*.tf) yonettigi kaynaklarla sinirli yetkiler. Adlari onceden
# bilinemeyen kaynak turlerinde (Cognito havuzu, API Gateway, olay kaynagi eslemesi) servis
# duzeyinde yetki verilir.
data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "Identity"
    actions   = ["sts:GetCallerIdentity", "ec2:DescribeRegions", "ec2:DescribeVpcs"]
    resources = ["*"]
  }

  statement {
    sid = "TerraformState"
    actions = [
      "s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
      "s3:CreateBucket", "s3:PutBucketVersioning", "s3:PutBucketPublicAccessBlock", "s3:GetBucketLocation",
    ]
    resources = [
      "arn:${local.partition}:s3:::${var.project}-tfstate-${local.account}-*",
      "arn:${local.partition}:s3:::${var.project}-tfstate-${local.account}-*/*",
    ]
  }

  statement {
    sid       = "DynamoDb"
    actions   = ["dynamodb:*"]
    resources = ["arn:${local.partition}:dynamodb:*:${local.account}:table/${var.project}*"]
  }

  statement {
    sid     = "Messaging"
    actions = ["sns:*", "sqs:*"]
    resources = [
      "arn:${local.partition}:sns:*:${local.account}:${var.project}*",
      "arn:${local.partition}:sqs:*:${local.account}:${var.project}*",
    ]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:*"]
    resources = ["arn:${local.partition}:logs:*:${local.account}:log-group:*${var.project}*"]
  }

  statement {
    sid       = "LogsDescribe"
    actions   = ["logs:DescribeLogGroups", "logs:DescribeMetricFilters", "logs:ListTagsForResource"]
    resources = ["*"]
  }

  # Online odeme anahtari secret'i (payments.tf): <proje>[-<ortam>]/payments/<saglayici>.
  # Dagitim yalnizca secret KAYNAGINI yonetir; degeri okuyamaz/yazamaz (GetSecretValue /
  # PutSecretValue YOK). Deger elle girilir.
  statement {
    sid = "PaymentSecrets"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:UpdateSecret",
      "secretsmanager:GetResourcePolicy",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
    ]
    resources = ["arn:${local.partition}:secretsmanager:*:${local.account}:secret:${var.project}*"]
  }

  # Belge deposu (storage.tf): <proje>[-<ortam>]-documents-<hesap>-<region>
  statement {
    sid     = "DocumentsBucket"
    actions = ["s3:*"]
    resources = [
      "arn:${local.partition}:s3:::${var.project}*-documents-${local.account}-*",
      "arn:${local.partition}:s3:::${var.project}*-documents-${local.account}-*/*",
    ]
  }

  # Zamanlanmis gorevler (scheduler.tf): grup adi <proje>[-<ortam>].
  statement {
    sid     = "Scheduler"
    actions = ["scheduler:*"]
    resources = [
      "arn:${local.partition}:scheduler:*:${local.account}:schedule-group/${var.project}*",
      "arn:${local.partition}:scheduler:*:${local.account}:schedule/${var.project}*/*",
    ]
  }

  statement {
    sid       = "LambdaFunctions"
    actions   = ["lambda:*"]
    resources = ["arn:${local.partition}:lambda:*:${local.account}:function:${var.project}*"]
  }

  statement {
    sid = "ServiceLevel"
    actions = [
      "lambda:CreateEventSourceMapping", "lambda:UpdateEventSourceMapping", "lambda:DeleteEventSourceMapping",
      "lambda:GetEventSourceMapping", "lambda:ListEventSourceMappings", "lambda:TagResource", "lambda:ListTags",
      "cognito-idp:*",
      "apigateway:*",
      "cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:DescribeAlarms",
      "cloudwatch:TagResource", "cloudwatch:ListTagsForResource",
      "ses:GetIdentityPolicies", "ses:PutIdentityPolicy", "ses:DeleteIdentityPolicy",
    ]
    resources = ["*"]
  }

  statement {
    sid = "IamRoles"
    actions = [
      "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:TagRole", "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PassRole",
    ]
    # Dagitim rolu kendini degistiremez (desen yalnizca yigin rollerini kapsar).
    resources = [
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-api",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-pre-token",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-notification-worker",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-scheduler-worker",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-scheduler",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-*-api",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-*-pre-token",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-*-notification-worker",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-*-scheduler-worker",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-*-scheduler",
    ]
  }

  # Tablo sifrelemesi AWS yonetimli anahtarla (aws/dynamodb): yalnizca DynamoDB uzerinden.
  statement {
    sid       = "KmsViaDynamoDb"
    actions   = ["kms:DescribeKey", "kms:CreateGrant", "kms:Decrypt", "kms:Encrypt"]
    resources = ["*"]

    condition {
      test     = "StringLike"
      variable = "kms:ViaService"
      values   = ["dynamodb.*.amazonaws.com"]
    }
  }

  statement {
    sid       = "IamReadManagedPolicies"
    actions   = ["iam:GetPolicy", "iam:GetPolicyVersion"]
    resources = ["arn:${local.partition}:iam::aws:policy/*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "serverless-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

output "deploy_role_arn" {
  description = "GitHub repo variable AWS_DEPLOY_ROLE_ARN olarak kaydedin."
  value       = aws_iam_role.deploy.arn
}
