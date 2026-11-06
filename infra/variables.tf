# ---------------------------------------------------------------------------
# Genel
# ---------------------------------------------------------------------------

variable "project" {
  type    = string
  default = "building-management"
}

variable "environment" {
  type        = string
  default     = "prod"
  description = "prod | staging | dev. prod disinda kaynak adlarina sonek eklenir."

  validation {
    condition     = contains(["prod", "staging", "dev"], var.environment)
    error_message = "environment prod, staging veya dev olmalidir."
  }
}

variable "app_version" {
  type        = string
  default     = "dev"
  description = "Lambda'ya APP_VERSION olarak gecer (CI'da git SHA); /api/health dondurur."
}

variable "alert_email" {
  type        = string
  default     = ""
  description = "DLQ ve Lambda hata alarmlarinin gidecegi e-posta. Bos ise abonelik olusturulmaz."
}

variable "log_retention_days" {
  type    = number
  default = 30
}

# ---------------------------------------------------------------------------
# DynamoDB
# ---------------------------------------------------------------------------

variable "dynamodb_deletion_protection" {
  type        = bool
  default     = true
  description = "Tablonun yanlislikla silinmesini engeller. Test ortamini yikmak icin false yapin."
}

# ---------------------------------------------------------------------------
# Cognito
# ---------------------------------------------------------------------------

variable "cognito_user_pool_tier" {
  type        = string
  default     = "ESSENTIALS"
  description = "Access token'a ozel claim ekleyen Pre Token Generation V2, ESSENTIALS veya PLUS gerektirir."

  validation {
    condition     = contains(["ESSENTIALS", "PLUS"], var.cognito_user_pool_tier)
    error_message = "Pre Token Generation V2 icin ESSENTIALS veya PLUS gereklidir."
  }
}

variable "cognito_admin_create_user_only" {
  type        = bool
  default     = true
  description = "true: kullanicilari yalnizca yonetim (davet) olusturur; acik kayit kapali."
}

variable "access_token_validity_minutes" {
  type        = number
  default     = 15
  description = "Kisa omur: sonlandirilan uyeliklerin erisimi en gec bu surede kesilir."
}

variable "refresh_token_validity_days" {
  type    = number
  default = 30
}

# ---------------------------------------------------------------------------
# Lambda / API
# ---------------------------------------------------------------------------

variable "lambda_dist_dir" {
  type        = string
  default     = null
  description = "`npm run build:lambda` ciktisi (api.mjs, pre-token.mjs). Varsayilan: ../apps/api/dist/lambda."
}

variable "lambda_runtime" {
  type        = string
  default     = "nodejs24.x"
  description = "nodejs20.x 30.04.2026'da deprecated oldu; uygulama node24 hedefiyle derlenir."
}

variable "api_lambda_memory_mb" {
  type    = number
  default = 512
}

variable "api_lambda_timeout_seconds" {
  type        = number
  default     = 15
  description = "HTTP API entegrasyon ust siniri 30 sn'dir."

  validation {
    condition     = var.api_lambda_timeout_seconds >= 3 && var.api_lambda_timeout_seconds <= 29
    error_message = "3-29 saniye arasinda olmalidir."
  }
}

variable "cors_allow_origins" {
  type        = list(string)
  default     = ["http://localhost:5173"]
  description = "React (Cloudflare Pages) alan adlari, ornegin https://app.ornek.com."
}

variable "api_throttle_rate_limit" {
  type        = number
  default     = 50
  description = "Saniyede ortalama istek (stage geneli)."
}

variable "api_throttle_burst_limit" {
  type    = number
  default = 100
}
