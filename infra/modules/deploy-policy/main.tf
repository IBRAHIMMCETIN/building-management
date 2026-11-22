# ---------------------------------------------------------------------------
# Serverless yigini (infra/*.tf) dagitan kimligin EN AZ YETKILI politikasi. Tek kaynak:
#   - infra/github-oidc       (OIDC rolu; SCP OIDC saglayicisina izin verirse)
#   - infra/github-deploy-user (bugunku CI: github-deploy erisim anahtari kullanicisi)
# Yeni bir AWS kaynak turu eklendiginde (ornegin payments.tf'deki Secrets Manager) yetki
# BURAYA eklenir; iki yigin da ayni politikayi kullanir.
# ---------------------------------------------------------------------------

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "project" {
  type = string
}

variable "account_id" {
  type = string
}

variable "partition" {
  type    = string
  default = "aws"
}

locals {
  account   = var.account_id
  partition = var.partition
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

  # API Gateway HTTP API erisim logu (api.tf: aws_apigatewayv2_stage.default.access_log_settings).
  # Stage olusturma/guncellemede API Gateway CloudWatch Logs "log delivery" kaydini cagiranin
  # yetkisiyle yonetir. Bu eylemler kaynak duzeyinde yetkilendirme desteklemez: yalnizca "*".
  # (AWS: "Configure logging for HTTP APIs" izin listesi; CreateLogGroup yukaridaki "Logs"
  # ifadesinde yigin log gruplariyla sinirli.)
  statement {
    sid = "ApiGatewayAccessLogDelivery"
    actions = [
      "logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery", "logs:ListLogDeliveries",
      "logs:PutResourcePolicy", "logs:DescribeResourcePolicies",
    ]
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
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-outbox-relay",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-scheduler",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-*-api",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-*-pre-token",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-*-notification-worker",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-*-scheduler-worker",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-*-outbox-relay",
      "arn:${local.partition}:iam::${local.account}:role/${var.project}-*-scheduler",
    ]
  }

  # Yigindaki musteri yonetimli KMS anahtarlari:
  #   - P4 (payments.tf): aktarim alicisi sifreleme anahtari (SYMMETRIC_DEFAULT / ENCRYPT_DECRYPT)
  #   - Faz B1 (bank.tf): banka ekstresi IBAN HMAC anahtari (HMAC_256 / GENERATE_VERIFY_MAC)
  # Anahtar olusturma kaynak duzeyinde kisitlanamaz; Project etiketi zorunlu ve yalnizca bu iki anahtar
  # turu olusturulabilir (IfExists: saglayici turu gondermezse varsayilan SYMMETRIC_DEFAULT'tur).
  # Yonetim islemleri yalnizca bu projenin etiketli anahtarlarinda; alias yalnizca <proje>* adinda.
  # Dagitim anahtarla SIFRELEME/COZME/MAC URETME yapamaz.
  statement {
    sid       = "KmsCreateProjectKey"
    actions   = ["kms:CreateKey", "kms:TagResource"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [var.project]
    }

    condition {
      test     = "StringEqualsIfExists"
      variable = "kms:KeySpec"
      values   = ["SYMMETRIC_DEFAULT", "HMAC_256"]
    }

    condition {
      test     = "StringEqualsIfExists"
      variable = "kms:KeyUsage"
      values   = ["ENCRYPT_DECRYPT", "GENERATE_VERIFY_MAC"]
    }
  }

  statement {
    sid = "KmsManageProjectKey"
    actions = [
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:EnableKeyRotation",
      "kms:ListResourceTags",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:UpdateKeyDescription",
      "kms:ScheduleKeyDeletion",
      "kms:CreateAlias",
      "kms:DeleteAlias",
      "kms:UpdateAlias",
    ]
    resources = ["arn:${local.partition}:kms:*:${local.account}:key/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [var.project]
    }
  }

  statement {
    sid       = "KmsPayeeAlias"
    actions   = ["kms:CreateAlias", "kms:DeleteAlias", "kms:UpdateAlias"]
    resources = ["arn:${local.partition}:kms:*:${local.account}:alias/${var.project}*"]
  }

  statement {
    sid       = "KmsList"
    actions   = ["kms:ListAliases"]
    resources = ["*"]
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

output "json" {
  description = "Politika belgesi (JSON)."
  value       = data.aws_iam_policy_document.deploy.json
}
