# ---------------------------------------------------------------------------
# Cognito User Pool + web istemcisi.
#
# Rol ve apartman bilgisi Cognito group'larinda TUTULMAZ (kullanici farkli apartmanlarda
# farkli rollerde olabilir). Akis:
#   1. Kullanici aktif apartmani `custom:active_apartment` (tercihen `custom:active_role`)
#      niteligine yazar ve token'i yeniler.
#   2. Pre Token Generation V2 Lambda (api.tf: pre_token) DynamoDB GSI1'den yetkileri okur,
#      secimi DOGRULAR ve access + id token'a `role`, `apartmentId` (+ `organizationId`)
#      claim'lerini ekler. Yetkisiz secim claim uretmez.
#   3. API Gateway JWT authorizer imzayi dogrular; Lambda claim'leri okur (AUTH_MODE=apigw).
# Tek istisna: `platform_admin` Cognito group'undan gelir.
# ---------------------------------------------------------------------------

resource "aws_cognito_user_pool" "main" {
  name           = local.name
  user_pool_tier = var.cognito_user_pool_tier

  # Giris e-posta ile. TODO(Faz 5): telefon/SMS OTP icin yerel SMS saglayicisi +
  # Custom SMS Sender trigger'i (Cognito'nun SNS SMS'i Turkiye'de kisitli/pahali).
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  username_configuration {
    case_sensitive = false
  }

  deletion_protection = local.is_prod ? "ACTIVE" : "INACTIVE"

  admin_create_user_config {
    allow_admin_create_user_only = var.cognito_admin_create_user_only
  }

  password_policy {
    minimum_length                   = 10
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  # TOTP (uygulama) ile istege bagli MFA; SMS MFA maliyet nedeniyle kapali.
  mfa_configuration = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # Varsayilan Cognito e-postasi gunluk ~50 ileti ile sinirlidir; uretimde SES'e gecin.
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  # Ozel nitelikler: yalnizca TERCIH tasir, yetki degildir (Pre Token Lambda dogrular).
  # Not: Cognito'da ozel nitelikler eklendikten sonra silinemez/degistirilemez; yalnizca
  # yeni nitelik eklenebilir. Mevcut bloklari degistirmeyin.
  schema {
    name                     = "active_apartment"
    attribute_data_type      = "String"
    mutable                  = true
    developer_only_attribute = false
    required                 = false

    string_attribute_constraints {
      min_length = 0
      max_length = 64
    }
  }

  schema {
    name                     = "active_role"
    attribute_data_type      = "String"
    mutable                  = true
    developer_only_attribute = false
    required                 = false

    string_attribute_constraints {
      min_length = 0
      max_length = 32
    }
  }

  lambda_config {
    pre_token_generation_config {
      lambda_arn     = aws_lambda_function.pre_token.arn
      lambda_version = "V2_0"
    }
  }

  tags = { Name = local.name }
}

resource "aws_cognito_user_group" "platform_admin" {
  name         = "platform_admin"
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "Platform ekibi. Apartman verisine erisimi ayrica loglanir."
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${local.name}-web"
  user_pool_id = aws_cognito_user_pool.main.id

  # Tarayici (SPA) istemcisi: gizli anahtar yok, SRP ile giris.
  generate_secret = false
  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = var.access_token_validity_minutes
  id_token_validity      = var.access_token_validity_minutes
  refresh_token_validity = var.refresh_token_validity_days

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  read_attributes = [
    "email",
    "email_verified",
    "name",
    "phone_number",
    "custom:active_apartment",
    "custom:active_role",
  ]

  # Kullanici yalnizca tercihlerini ve profil adini yazabilir.
  write_attributes = [
    "name",
    "custom:active_apartment",
    "custom:active_role",
  ]
}

resource "aws_lambda_permission" "cognito_pre_token" {
  statement_id  = "AllowCognitoPreTokenGeneration"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.pre_token.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.main.arn
}
