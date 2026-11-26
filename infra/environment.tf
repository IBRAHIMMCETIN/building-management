# ---------------------------------------------------------------------------
# Ortam: alan adi baglama ve prod korkuluklari.
#
# Alan adi (custom_domain): satin alininca prod.tfvars'ta TEK satir acilir:
#   custom_domain = "yonetimsistemim.com"
# Etkisi (plan/apply ile):
#   - Web adresi `https://<web_subdomain>.<custom_domain>` (varsayilan app.) API ve belge bucket
#     CORS listesine eklenir; web_app_url (odeme donusu + e-posta baglantilari) bu adres olur.
#   - Mevcut pages.dev adresleri listede kalir (gecis surecinde iki adres de calisir); gecis
#     bitince prod.tfvars'tan silinir.
# SES (e-posta) bu degiskenle ACILMAZ: alan adi kimligi DNS'te dogrulanmadan Cognito/SES'i
# baglamak plan/apply'i bozar. Sira: README "Canliya Gecis Kontrol Listesi" -> SES adimlari.
#
# Prod korkuluklari (production_guardrails = true, yalnizca prod.tfvars): plan, prod icin
# guvensiz bir ayarla (MFA zorunlu degil, alarm e-postasi yok, http/localhost CORS, silme
# korumasi kapali...) HIC baslamaz. Dev/staging ve plan testleri etkilenmez.
# ---------------------------------------------------------------------------

variable "custom_domain" {
  type        = string
  default     = ""
  description = "Uygulamanin kok alan adi (ornegin yonetimsistemim.com). Bos: yalnizca cors_allow_origins / web_app_url kullanilir."

  validation {
    condition     = var.custom_domain == "" || can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.custom_domain))
    error_message = "custom_domain kucuk harfli bir alan adi olmalidir (ornegin yonetimsistemim.com); https:// veya / icermez."
  }
}

variable "web_subdomain" {
  type        = string
  default     = "app"
  description = "Web uygulamasinin alt alan adi (app -> app.<custom_domain>). Bos: kok alan adi."

  validation {
    condition     = var.web_subdomain == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.web_subdomain))
    error_message = "web_subdomain tek bir DNS etiketi olmalidir (ornegin app)."
  }
}

variable "production_guardrails" {
  type        = bool
  default     = false
  description = "true (yalnizca prod.tfvars): prod icin guvensiz ayarlarla plan baslamaz."
}

locals {
  web_custom_host = var.custom_domain == "" ? "" : (var.web_subdomain == "" ? var.custom_domain : "${var.web_subdomain}.${var.custom_domain}")
  web_custom_url  = local.web_custom_host == "" ? "" : "https://${local.web_custom_host}"

  # API Gateway + belge bucket CORS'u ve web adresi bu degerleri kullanir (api.tf, storage.tf,
  # payments.tf, worker.tf).
  cors_allow_origins = distinct(compact(concat(var.cors_allow_origins, [local.web_custom_url])))
  web_app_url        = local.web_custom_url != "" ? local.web_custom_url : var.web_app_url

  payments_live = (
    (contains(local.payment_providers, "iyzico") && var.iyzico_base_url == "https://api.iyzipay.com") ||
    (contains(local.payment_providers, "paytr") && !var.paytr_test_mode)
  )
}

# Plan asamasinda calisan kontroller. Kaynak bir sey olusturmaz (terraform_data).
resource "terraform_data" "production_guardrails" {
  count = var.production_guardrails ? 1 : 0

  input = {
    environment = var.environment
    origins     = local.cors_allow_origins
  }

  lifecycle {
    precondition {
      condition     = var.environment == "prod"
      error_message = "production_guardrails yalnizca environment = \"prod\" ile kullanilir."
    }
    precondition {
      condition     = var.mfa_enforcement_mode == "enforce"
      error_message = "Prod'da yonetici/denetci rolleri icin MFA zorunlu olmali: mfa_enforcement_mode = \"enforce\"."
    }
    precondition {
      condition     = trimspace(var.alert_email) != ""
      error_message = "Prod'da alarm e-postasi zorunlu: GitHub repo/production environment variable ALERT_EMAIL (TF_VAR_alert_email). Ilk apply'dan sonra SNS onay e-postasindaki baglanti tiklanmalidir."
    }
    precondition {
      condition     = length(local.cors_allow_origins) > 0 && alltrue([for o in local.cors_allow_origins : startswith(o, "https://") && !strcontains(o, "localhost") && !strcontains(o, "127.0.0.1")])
      error_message = "Prod CORS listesi yalnizca https web adreslerini icermeli (localhost / http yok)."
    }
    precondition {
      condition     = local.web_app_url != "" && startswith(local.web_app_url, "https://")
      error_message = "Prod'da web_app_url (veya custom_domain) zorunlu: e-posta ve odeme donus baglantilari bu adrese gider."
    }
    precondition {
      condition     = var.dynamodb_deletion_protection
      error_message = "Prod'da dynamodb_deletion_protection kapatilamaz."
    }
    precondition {
      condition     = var.scheduler_enabled
      error_message = "Prod'da zamanlanmis gorevler (aidat, gecikme tazminati, gece denetimi) kapali olamaz."
    }
    precondition {
      condition     = var.cognito_admin_create_user_only
      error_message = "Prod'da acik kayit kapali olmali (cognito_admin_create_user_only = true)."
    }
    precondition {
      condition     = var.notification_channel != "ses" || var.ses_identity_arn != ""
      error_message = "notification_channel = \"ses\" icin dogrulanmis ses_identity_arn gerekir."
    }
    precondition {
      condition     = !local.payments_live || (local.web_custom_url != "" && var.payments_pos_rate_bps > 0)
      error_message = "Canli odeme (iyzico api.iyzipay.com / PayTR test_mode=false) yalnizca alan adi baglandiktan ve saglayici komisyon orani (payments_pos_rate_bps) girildikten sonra acilir."
    }
  }
}
