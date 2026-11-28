# ---------------------------------------------------------------------------
# PROD ortami degiskenleri. CI (v* etiketi veya workflow_dispatch target=prod) her plan'a
# otomatik ekler (scripts/ci/tf-init.sh). Elle:
#   terraform -chdir=infra plan "-var-file=prod.tfvars" "-out=prod.tfplan"
# Gizli bilgi ICERMEZ; repoda tutulur. Gizliler / kisisel bilgiler GitHub'dan gelir:
#   ALERT_EMAIL (zorunlu), SES_IDENTITY_ARN, SES_FROM_ADDRESS  -> TF_VAR_* (bkz. workflow)
# Not: -var-file degerleri TF_VAR_* ortam degiskenlerini EZER. Bu yuzden alert_email,
# ses_identity_arn, ses_from_address burada YAZILMAZ (yazilirsa GitHub degeri devre disi kalir).
#
# Dagitim kontrol listesi: infra/PROD_DEPLOY.md
# ---------------------------------------------------------------------------

environment = "prod"

# Plan, prod icin guvensiz bir ayarla baslamaz (environment.tf): MFA enforce, alarm e-postasi,
# yalnizca https CORS, silme korumasi, zamanlayici acik, acik kayit kapali, canli odeme kilidi.
production_guardrails = true

# --- Alan adi -----------------------------------------------------------------
# Alan adi SATIN ALININCA bu satirin basindaki # kaldirilir (tek satir). app.yonetimsistemim.com
# CORS'a eklenir ve web_app_url (odeme donusu, e-posta baglantilari) bu adres olur.
# Once Cloudflare Pages prod projesine ozel alan adi (app.yonetimsistemim.com) baglanmalidir.
# custom_domain = "yonetimsistemim.com"
web_subdomain = "app"

# Alan adi baglanana kadar prod web uygulamasinin adresi (Cloudflare Pages prod projesi).
# YER TUTUCU: prod Pages projesi olusturulunca gercek *.pages.dev adresiyle degistirin
# (ayni deger asagidaki CORS listesinde de). custom_domain acildiginda web_app_url yerini
# otomatik olarak https://app.yonetimsistemim.com alir.
web_app_url = "https://yonetimsistemim.pages.dev"

# API Gateway + belge bucket CORS. Yalnizca https; localhost / preview adresleri YOK.
# custom_domain acildiginda app.<alan adi> otomatik eklenir; gecis bitince pages.dev silinir.
cors_allow_origins = [
  "https://yonetimsistemim.pages.dev",
]

# --- Kimlik ve guvenlik ---------------------------------------------------------
# Yonetici, yonetim firmasi, denetci ve platform yoneticisi icin TOTP zorunlu (gecis suresi yok).
mfa_enforcement_mode           = "enforce"
cognito_admin_create_user_only = true
cognito_user_pool_tier         = "LITE"
access_token_validity_minutes  = 15
refresh_token_validity_days    = 30

# --- Veri ve kayitlar -----------------------------------------------------------
dynamodb_deletion_protection = true
# Lambda loglari 90 gun (olay incelemesi / denetim icin dev'den uzun).
log_retention_days = 90

# --- Zamanlanmis gorevler --------------------------------------------------------
scheduler_enabled = true

# --- Bildirim -------------------------------------------------------------------
# SES alan adi kimligi dogrulanip sandbox'tan cikilana kadar "log" kalir (e-posta gonderilmez).
# Gecis: README "Canliya Gecis Kontrol Listesi" > SES adimlari, sonra:
#   notification_channel = "ses"  (+ GitHub: SES_IDENTITY_ARN, SES_FROM_ADDRESS)
notification_channel      = "log"
notification_from_address = "YÖNESİST <bildirim@yonetimsistemim.com>"
# Mobil bildirim (Expo push): varsayilan acik (push_channel = "expo"); kayitli cihaz yokken dis istek
# yapilmaz. Kapatmak icin push_channel = "off". Istege bagli Expo erisim anahtari tfvars'a YAZILMAZ:
# TF_VAR_expo_access_token (CI secret) ile verilir.

# --- Online odeme: GUVENLI BASLANGIC (kapali) -------------------------------------
# Pazaryeri yetkisi, ticari sozlesmeler ve sandbox uctan uca testi tamamlanana kadar kapali.
# Acma sirasi (PROD_DEPLOY.md > Online odeme):
#   1) payments_providers = ["iyzico"] + iyzico sandbox (asagidaki adres) ile prod'da deneme,
#   2) sozlesme oranlari (payments_pos_rate_bps / payments_pos_fixed_fee_kurus),
#   3) custom_domain acik + iyzico_base_url = "https://api.iyzipay.com" (canli).
# Canli adres / PayTR test_mode=false, alan adi ve komisyon orani olmadan plan'i durdurur.
payments_provider            = "disabled"
payments_providers           = []
iyzico_base_url              = "https://sandbox-api.iyzipay.com"
paytr_test_mode              = true
payments_pos_rate_bps        = 0
payments_pos_fixed_fee_kurus = 0
platform_invoice_mode        = "monthly"

# --- API kapasitesi ----------------------------------------------------------------
# Pilot (~300 bagimsiz bolum) icin varsayilanlar yeterli; buyuk portfoyde artirin.
api_lambda_memory_mb       = 1024
api_lambda_timeout_seconds = 15
api_throttle_rate_limit    = 50
api_throttle_burst_limit   = 100
