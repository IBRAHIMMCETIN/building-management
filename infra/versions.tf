# Serverless yigin (Faz 4): DynamoDB + Cognito + SNS/SQS + Lambda + API Gateway (HTTP API).
#
# Diger yiginlar (infra/ec2, infra/budget) kendi klasorlerinde ve ayri state'lerde durur;
# Terraform yalnizca calistirildigi klasordeki .tf dosyalarini okudugundan bu kok modul
# onlari etkilemez. CI ornegi:
#   terraform -chdir=infra init -backend-config="key=serverless/terraform.tfstate" ...
#   npm --prefix apps/api run build:lambda   (apply'dan once; bkz. api.tf)

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # Bucket, key ve region CI'da -backend-config ile verilir (infra/ec2 ile ayni desen).
  backend "s3" {}
}

# Region acikca sabitlenir: AWS_REGION/CLI profili farkli bir bolgeyi gosterse bile (ornegin
# eu-central-1) yanlis bolgede plan yapilmaz. Hesaptaki SCP projenin bolgesi disindaki islemleri
# reddeder ve bolge adini iceren kaynaklar (belge bucket'i) yeniden olusturulmak istenir.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
      Stack       = "serverless"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  # prod'da kaynak adlari yalin ("building-management"); diger ortamlarda sonek alir.
  name      = var.environment == "prod" ? var.project : "${var.project}-${var.environment}"
  region    = data.aws_region.current.region
  partition = data.aws_partition.current.partition
  is_prod   = var.environment == "prod"
}
