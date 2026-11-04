terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Bucket, key ve region CI'da -backend-config ile verilir (bkz. deploy-web-ec2.yml).
  backend "s3" {}
}

# Region AWS_REGION ortam degiskeninden gelir (projenin secili region'i olmali).
provider "aws" {
  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
    }
  }
}
