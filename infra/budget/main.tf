terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # EC2 stack'inden ayri state: budget adimi hata verse bile deploy etkilenmez.
  backend "s3" {}
}

provider "aws" {
  default_tags {
    tags = {
      Project   = "building-management"
      ManagedBy = "terraform"
    }
  }
}

variable "alert_email" {
  type        = string
  description = "Uyarilarin gidecegi e-posta (GitHub variable BUDGET_ALERT_EMAIL)."
}

variable "monthly_limit_usd" {
  type    = number
  default = 15
}

resource "aws_budgets_budget" "monthly" {
  name         = "building-management-monthly"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Free plan kredisi her seyi karsiladigi icin kredi dahil maliyet hep 0 gorunur.
  # Krediden onceki gercek kullanimi izliyoruz.
  cost_types {
    include_credit = false
    include_refund = false
  }

  dynamic "notification" {
    for_each = [50, 80]

    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.alert_email]
    }
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
