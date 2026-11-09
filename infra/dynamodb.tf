# ---------------------------------------------------------------------------
# Tek tablo (single-table design), multi-tenant.
#
#   PK = APT#<apartmentId>              (tenant izolasyonu; tum apartman kayitlari)
#   SK = SITE | UNIT#.. | ACCT#.. | TX#.. | LE#.. | PAY#.. | MEMBER#<userId>#<unitId> | ANN#..
#
# GSI1 (kullanici -> apartman yetkileri; Pre Token Generation Lambda okur):
#   GSI1PK = USER#<userId>, GSI1SK = APT#<apartmentId>#UNIT#<unitId>
#
# TTL: `ttl` alani (epoch saniye) tasiyan kayitlar (ornegin gecici idempotency/oturum
# kayitlari) otomatik silinir. Defter (TX/LE) kayitlari bu alani ASLA tasimaz.
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "main" {
  name                        = local.name
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

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  # AWS yonetimli KMS anahtari (aws/dynamodb).
  server_side_encryption {
    enabled = true
  }

  tags = { Name = local.name }
}
