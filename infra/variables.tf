# ---------------------------------------------------------------------------
# Genel
# ---------------------------------------------------------------------------

variable "project" {
  type    = string
  default = "building-management"
}

# Bilerek varsayilan YOK: unutulursa Terraform sorar / CI'da hata verir. Varsayilan "prod"
# iken dev state'i ile -var verilmeden alinan apply, dev kaynaklarini silip prod adlariyla
# yeniden olusturdu (12.11.2026). Dev: -var-file=dev.tfvars, CI: TF_VAR_environment.
variable "environment" {
  type        = string
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
  default     = "LITE"
  description = <<-EOT
    LITE (varsayilan): 10.000 MAU/ay ucretsiz, sonrasi en ucuz katman. Pre Token Generation V1
    yalnizca ID token'a claim ekler -> istemci API'ye ID token gonderir.
    ESSENTIALS: ayni ucretsiz kota, sonrasi ~3 kat pahali; V2 ile access token'a da claim eklenir.
    PLUS: ucretsiz kotasi yok; bu proje icin gereksiz.
  EOT

  validation {
    condition     = contains(["LITE", "ESSENTIALS"], var.cognito_user_pool_tier)
    error_message = "LITE veya ESSENTIALS olmalidir (PLUS'in ucretsiz kotasi yoktur)."
  }
}

# --- E-posta (SES) ----------------------------------------------------------
# Cognito'nun varsayilan e-postasi gunluk ~50 ileti ile sinirlidir. Uretimde SES kullanin:
#   1. SES'te alan adini/adresi dogrulayin (ve sandbox'tan cikis talep edin).
#   2. Asagidaki iki degiskeni verin. Bos birakilirsa COGNITO_DEFAULT kullanilir.

variable "ses_identity_arn" {
  type        = string
  default     = ""
  description = "Dogrulanmis SES kimliginin ARN'i (arn:aws:ses:<region>:<hesap>:identity/ornek.com)."

  validation {
    condition     = var.ses_identity_arn == "" || can(regex("^arn:aws[a-z-]*:ses:[a-z0-9-]+:[0-9]{12}:identity/.+$", var.ses_identity_arn))
    error_message = "Gecerli bir SES identity ARN'i olmalidir."
  }
}

variable "ses_from_address" {
  type        = string
  default     = ""
  description = "Gonderen adresi, ornegin \"Bina Yonetim <no-reply@ornek.com>\". ses_identity_arn ile birlikte verilmelidir."
}

variable "ses_reply_to" {
  type    = string
  default = ""
}

# --- Bildirim e-postalari (notification worker) ---------------------------------
# log: yapilandirilmis log (dis gonderim yok; dev/test varsayilani).
# ses: SES ile e-posta. ses_identity_arn, gonderen adresin alan adini veya adresini kapsamali.
variable "notification_channel" {
  type        = string
  default     = "log"
  description = "Bildirim kanali: log | ses."

  validation {
    condition     = contains(["log", "ses"], var.notification_channel)
    error_message = "notification_channel log veya ses olmalidir."
  }
}

# --- Mobil bildirim (push, Expo) -------------------------------------------------
# expo: notification worker alicinin kayitli Expo cihazlarina push gonderir (cihaz yoksa dis istek
#       yok) ve scheduler saatte bir makbuzlari kontrol eder. off: push yok, makbuz isi yok.
variable "push_channel" {
  type        = string
  default     = "expo"
  description = "Mobil bildirim kanali: expo | off."

  validation {
    condition     = contains(["expo", "off"], var.push_channel)
    error_message = "push_channel expo veya off olmalidir."
  }
}

# Karisik proje hatasinda (PUSH_TOO_MANY_EXPERIENCE_IDS) bizim projemiz: Expo hata ayrintisindaki proje
# anahtari (or. "@sahip/yonesist"). Verilirse baska projelerin token'lari pasife alinir; bos ise hicbiri.
# Expo erisim anahtari Terraform degiskeni DEGILDIR: push.tf'teki secret'a elle girilir.
variable "expo_project_id" {
  type        = string
  default     = ""
  description = "Istege bagli Expo proje anahtari (EXPO_PROJECT_ID), or. @sahip/yonesist."

  validation {
    condition     = var.expo_project_id == "" || can(regex("^(@[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+|[0-9a-f-]{36})$", var.expo_project_id))
    error_message = "expo_project_id \"@sahip/slug\" veya proje UUID'si olmalidir."
  }
}

variable "mfa_enforcement_mode" {
  type        = string
  default     = "warn"
  description = "Yonetici/denetci rolleri icin zorunlu TOTP MFA: off | warn (kullanici bazli gecis suresi, sonra zorunlu) | enforce."

  validation {
    condition     = contains(["off", "warn", "enforce"], var.mfa_enforcement_mode)
    error_message = "mfa_enforcement_mode off, warn veya enforce olmalidir."
  }
}

variable "mfa_grace_period_days" {
  type        = number
  default     = 7
  description = "warn modunda TOTP kurmamis yonetici/denetciye taninan gun (kullanici bazli, ilk giristen itibaren)."

  validation {
    condition     = var.mfa_grace_period_days >= 0 && var.mfa_grace_period_days <= 90 && floor(var.mfa_grace_period_days) == var.mfa_grace_period_days
    error_message = "mfa_grace_period_days 0-90 arasi tam sayi olmalidir."
  }
}

variable "notification_from_address" {
  type        = string
  default     = "YÖNESİST <bildirim@yonetimsistemim.com>"
  description = "Bildirim e-postalarinin gondereni (SES_FROM_ADDRESS). Gorunen addaki ASCII disi karakterleri uygulama MIME ile kodlar."

  validation {
    condition     = can(regex("^([^<>]*<)?[^@<>\\s]+@[^@<>\\s]+\\.[^@<>\\s]+>?$", trimspace(var.notification_from_address)))
    error_message = "notification_from_address \"Ad <adres@alan.com>\" veya \"adres@alan.com\" biciminde olmalidir."
  }
}

variable "ses_configuration_set" {
  type        = string
  default     = ""
  description = "Istege bagli SES yapilandirma seti (geri donus/sikayet olaylari icin). Bos ise kullanilmaz."

  validation {
    condition     = var.ses_configuration_set == "" || can(regex("^[A-Za-z0-9_-]{1,64}$", var.ses_configuration_set))
    error_message = "ses_configuration_set yalnizca harf, rakam, - ve _ icerebilir (en fazla 64)."
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

# --- Hassas rotalarda throttling (security_monitoring.tf) ---

variable "mfa_route_rate_limit" {
  type        = number
  default     = 1
  description = "MFA kurulum/dogrulama rotalari (POST /api/me/mfa/totp/*): saniyede ortalama istek."
}

variable "mfa_route_burst_limit" {
  type    = number
  default = 5
}

variable "security_admin_route_rate_limit" {
  type        = number
  default     = 1
  description = "MFA sifirlama ve destek oturumu acma rotalari: saniyede ortalama istek."
}

variable "security_admin_route_burst_limit" {
  type    = number
  default = 3
}

variable "bulk_write_route_rate_limit" {
  type        = number
  default     = 2
  description = "Davet, toplu tahakkuk ve toplu aktarim baslatma rotalari: saniyede ortalama istek."
}

variable "bulk_write_route_burst_limit" {
  type    = number
  default = 5
}

variable "gate_route_rate_limit" {
  type        = number
  default     = 100
  description = "Guvenlik kapisi QR / kisa kod dogrulama ve plaka aramasi rotalari: saniyede ortalama istek. PLATFORM GENELI rota siniridir (tum apartmanlarin gorevlileri ayni kovayi paylasir): arka uc kapasitesine gore secilir, istemci basina sinir degildir. Istemci basina sinir uygulamadaki kullanici / apartman sayacidir (gate/throttle.ts), ileride Cloudflare ile IP basina."

  validation {
    condition     = var.gate_route_rate_limit >= 1
    error_message = "gate_route_rate_limit en az 1 olmali."
  }
}

variable "gate_route_burst_limit" {
  type    = number
  default = 200
}

# --- Guvenlik alarm esikleri (security_monitoring.tf) ---

variable "signin_failure_alarm_threshold" {
  type        = number
  default     = 20
  description = "5 dakikada bu sayiyi asan basarisiz Cognito girisi alarm uretir."
}

variable "mfa_verify_failure_alarm_threshold" {
  type        = number
  default     = 10
  description = "5 dakikada bu sayiyi asan hatali TOTP kurulum kodu alarm uretir."
}

variable "mfa_reset_alarm_threshold" {
  type        = number
  default     = 3
  description = "1 saatte bu sayiyi asan MFA sifirlama alarm uretir."
}

variable "gate_lockout_alarm_threshold" {
  type        = number
  default     = 3
  description = "1 saatte bu sayida veya daha fazla guvenlik kapisi deneme kilitlenmesi (GateLockout) alarm uretir."
}

variable "api_5xx_alarm_threshold" {
  type        = number
  default     = 5
  description = "5 dakikada bu sayida veya daha fazla API Gateway 5xx yaniti alarm uretir."
}

variable "bank_recon_diff_alarm_threshold" {
  type        = number
  default     = 0
  description = "Faz B3: gece denetiminde bir apartmanin banka mutabakatindaki aciklanamayan fark (kurus, mutlak) bu degeri asarsa alarm uretir (operations.tf)."

  validation {
    condition     = var.bank_recon_diff_alarm_threshold >= 0 && floor(var.bank_recon_diff_alarm_threshold) == var.bank_recon_diff_alarm_threshold
    error_message = "bank_recon_diff_alarm_threshold negatif olmayan tam sayi (kurus) olmali."
  }
}

variable "scheduler_enabled" {
  description = "Zamanlanmis gorevler (aylik aidat, gecikme tazminati, hatirlatma) acik mi? Kapaliyken zamanlamalar DISABLED olur; worker ve kuyruk yine kurulur (elle tetiklenebilir)."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Online odeme (Adim 8b)
# ---------------------------------------------------------------------------

variable "payments_provider" {
  type        = string
  default     = "disabled"
  description = "Eski tekil ayar: disabled | iyzico | paytr. `payments_providers` verilmisse yok sayilir. (fake yalnizca yerel gelistirme icindir.)"

  validation {
    condition     = contains(["disabled", "iyzico", "paytr"], var.payments_provider)
    error_message = "payments_provider disabled, iyzico veya paytr olmalidir."
  }
}

variable "payments_providers" {
  type        = list(string)
  default     = []
  description = "Online Odeme v2: acik saglayicilar (iyzico, paytr). Bos ise `payments_provider` kullanilir."

  validation {
    condition     = alltrue([for p in var.payments_providers : contains(["iyzico", "paytr"], p)]) && length(distinct(var.payments_providers)) == length(var.payments_providers)
    error_message = "payments_providers yalnizca iyzico ve/veya paytr icerebilir (tekrarsiz)."
  }
}

variable "default_payment_provider" {
  type        = string
  default     = ""
  description = "Apartman tercihi yoksa kullanilan saglayici (DEFAULT_PAYMENT_PROVIDER). Bos: listedeki ilk saglayici."

  validation {
    condition     = contains(["", "iyzico", "paytr"], var.default_payment_provider)
    error_message = "default_payment_provider bos, iyzico veya paytr olmalidir."
  }
}

variable "paytr_transfer_delay_hours" {
  type        = number
  default     = 24
  description = "P4: PayTR odeme onayindan sonra Platform Transfer talimati icin bekleme (saat, 0-720). Talimat en erken odemenin ertesi gunu verilir."

  validation {
    condition     = var.paytr_transfer_delay_hours >= 0 && var.paytr_transfer_delay_hours <= 720 && floor(var.paytr_transfer_delay_hours) == var.paytr_transfer_delay_hours
    error_message = "paytr_transfer_delay_hours 0-720 arasi tam sayi olmalidir."
  }
}

variable "platform_invoice_mode" {
  type        = string
  default     = "monthly"
  description = "P4: platform komisyon faturasi modeli: monthly (donemsel) | per_payment (odeme bazli)."

  validation {
    condition     = contains(["monthly", "per_payment"], var.platform_invoice_mode)
    error_message = "platform_invoice_mode monthly veya per_payment olmalidir."
  }
}

variable "platform_invoice_vat_bps" {
  type        = number
  default     = 2000
  description = "P4: platform komisyon faturasinda KDV orani (baz puan; 2000 = %20)."

  validation {
    condition     = var.platform_invoice_vat_bps >= 0 && var.platform_invoice_vat_bps <= 5000 && floor(var.platform_invoice_vat_bps) == var.platform_invoice_vat_bps
    error_message = "platform_invoice_vat_bps 0-5000 arasi tam sayi olmalidir."
  }
}

variable "platform_invoice_vat_mode" {
  type        = string
  default     = "inclusive"
  description = "P4/P5: inclusive (varsayilan; odemede kesilen platform payi KDV dahil, fatura = defter gideri) | exclusive (pay KDV haric, KDV ustune)."

  validation {
    condition     = contains(["exclusive", "inclusive"], var.platform_invoice_vat_mode)
    error_message = "platform_invoice_vat_mode exclusive veya inclusive olmalidir."
  }
}

variable "paytr_test_mode" {
  type        = bool
  default     = true
  description = "PayTR `test_mode` (PAYTR_TEST_MODE). Canli magazada gercek tahsilat icin false."
}

variable "iyzico_base_url" {
  type        = string
  default     = "https://sandbox-api.iyzipay.com"
  description = "iyzico API adresi: sandbox veya canli."

  validation {
    condition     = contains(["https://sandbox-api.iyzipay.com", "https://api.iyzipay.com"], var.iyzico_base_url)
    error_message = "iyzico_base_url https://sandbox-api.iyzipay.com veya https://api.iyzipay.com olmalidir."
  }
}

variable "web_app_url" {
  type        = string
  default     = ""
  description = "Odeme sonrasi kullanicinin donecegi web uygulamasi (Cloudflare Pages), ornegin https://app.ornek.com. Online odeme acikken zorunlu."

  validation {
    condition     = var.web_app_url == "" || can(regex("^https://[a-z0-9.-]+$", var.web_app_url))
    error_message = "web_app_url sonunda / olmayan bir https kok adresi olmalidir."
  }
}

# Online Odeme v2 (P1): komisyonu apartman oder; sakine ek ucret yansitilmaz (5464 s. K. m.17).
# Odeme aninda alt uye isyeri payi = tutar - platform ucreti - POS tahmini. POS tahmini, saglayiciyla
# yapilan sozlesme oranindan hesaplanir; gercek komisyon mutabakat kaydina ayrica yazilir.
# Hesap bazinda (PATCH /api/admin/payments/apartments/{id}/account) gecersiz kilinabilir.
variable "payments_pos_rate_bps" {
  type        = number
  default     = 0
  description = "Saglayici sozlesme komisyon orani, baz puan (249 = %2,49). 0-1000."

  validation {
    condition     = var.payments_pos_rate_bps >= 0 && var.payments_pos_rate_bps <= 1000 && floor(var.payments_pos_rate_bps) == var.payments_pos_rate_bps
    error_message = "payments_pos_rate_bps 0-1000 arasi tam sayi olmalidir."
  }
}

variable "payments_pos_fixed_fee_kurus" {
  type        = number
  default     = 0
  description = "Islem basina sabit saglayici ucreti, kurus (25 = 0,25 TL). 0-5000."

  validation {
    condition     = var.payments_pos_fixed_fee_kurus >= 0 && var.payments_pos_fixed_fee_kurus <= 5000 && floor(var.payments_pos_fixed_fee_kurus) == var.payments_pos_fixed_fee_kurus
    error_message = "payments_pos_fixed_fee_kurus 0-5000 arasi tam sayi olmalidir."
  }
}

variable "payments_callback_rate_limit" {
  type        = number
  default     = 5
  description = "Kimliksiz odeme callback/webhook rotalari icin saniyede ortalama istek (rota bazli throttling)."
}

variable "public_form_route_rate_limit" {
  type        = number
  default     = 1
  description = "Tanitim sayfasi demo talep formu (POST /api/public/demo-requests, kimliksiz) icin saniyede ortalama istek; platform geneli rota kovasi. Istemci basina sinir uygulamadadir (IP basina saatte 5)."
}

variable "public_form_route_burst_limit" {
  type        = number
  default     = 5
  description = "Demo talep formu rotasinin anlik (burst) siniri."
}

variable "aws_region" {
  type        = string
  default     = "eu-north-1"
  description = "Projenin AWS bolgesi. Hesaptaki SCP diger bolgelerdeki islemleri reddeder; state de bu bolgededir."

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.aws_region))
    error_message = "aws_region gecerli bir AWS bolge kodu olmalidir (ornegin eu-north-1)."
  }
}
