# ---------------------------------------------------------------------------
# Degistirilemez denetim gunlugu (Guvenlik G1).
#
# Kod: apps/api/src/modules/audit (log.ts yazim, repository.ts okuma/dogrulama)
#   PK = APT#<apartmentId> | PLATFORM,  SK = SEQ#<12 hane>   (kapsam basina hash zinciri)
#   GSI1: ACTOR#<userId> / <zaman>#<kapsam>#<sira>           (aktore gore sorgu)
#
# Degistirilemezlik katmanlari:
#  1. Uygulama rolleri yalnizca PutItem / GetItem / Query (api.tf, scheduler.tf). Yazim her zaman
#     `attribute_not_exists` kosullu ve hassas islemle ayni TransactWriteItems'ta.
#  2. Rollerde ayrica acik Deny (UpdateItem / DeleteItem / BatchWriteItem / PartiQL).
#  3. Tablo kaynak politikasi bu islemleri TUM principal'lar icin reddeder (yonetici dahil).
#     TTL silmesi DynamoDB servisi tarafindan yapildigindan etkilenmez.
#  4. Hash zinciri: ustune yazma (hash uyusmazligi) ve silme (sira boslugu) gecelik
#     ledger_audit'te yakalanir (LedgerDrift / AuditChainBroken metrikleri + alarm).
# Saklama: kayit basina `ttl` = zaman + 10 yil. PITR ve silme korumasi acik.
# ---------------------------------------------------------------------------

locals {
  audit_table_name = "${local.name}-audit"
  # Denetim tablosunda hicbir principal'in yapamayacagi islemler.
  audit_mutating_actions = [
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
    "dynamodb:BatchWriteItem",
    "dynamodb:PartiQLUpdate",
    "dynamodb:PartiQLDelete",
    "dynamodb:PartiQLInsert",
  ]
  # Uygulama rollerine verilen tek yetki seti (ekle + oku).
  audit_app_actions = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query"]
}

resource "aws_dynamodb_table" "audit" {
  name                        = local.audit_table_name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "PK"
  range_key                   = "SK"
  deletion_protection_enabled = var.dynamodb_deletion_protection

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  attribute {
    name = "GSI1PK"
    type = "S"
  }

  attribute {
    name = "GSI1SK"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    projection_type = "ALL"

    key_schema {
      attribute_name = "GSI1PK"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "GSI1SK"
      key_type       = "RANGE"
    }
  }

  point_in_time_recovery {
    enabled = true
  }

  # 10 yillik saklama: kayit basina `ttl` (uygulama yazar).
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = { Name = local.audit_table_name }
}

data "aws_iam_policy_document" "audit_table" {
  statement {
    sid       = "DenyAuditMutation"
    effect    = "Deny"
    actions   = local.audit_mutating_actions
    resources = [aws_dynamodb_table.audit.arn]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_dynamodb_resource_policy" "audit" {
  resource_arn = aws_dynamodb_table.audit.arn
  policy       = data.aws_iam_policy_document.audit_table.json
}
