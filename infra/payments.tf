# ---------------------------------------------------------------------------
# Online odeme: iyzico Checkout Form + Pazaryeri (Adim 8b), PayTR iFrame (Online Odeme v2 · P3).
#
# Kod: apps/api/src/modules/payments (API Lambda + scheduler worker'daki payment_reconcile).
# - Acik saglayicilar `payments_providers` (eski tekil `payments_provider` da okunur), varsayilan
#   `default_payment_provider`; apartman bazinda tercih API'den (PUT .../settings).
# - Anahtarlar saglayici basina Secrets Manager'da: Terraform yalnizca bos secret'i olusturur,
#   DEGERI GIRMEZ (state'e gizli bilgi yazilmaz). Deger elle girilir (`terraform output payments_secret_arns`):
#     iyzico: aws secretsmanager put-secret-value --secret-id <arn> \
#               --secret-string '{"apiKey":"sandbox-...","secretKey":"sandbox-..."}'
#     paytr : aws secretsmanager put-secret-value --secret-id <arn> \
#               --secret-string '{"merchantId":"123456","merchantKey":"...","merchantSalt":"..."}'
#   Lambda anahtari ilk istekte okur ve 5 dk bellekte tutar.
# - Kimliksiz rotalar YALNIZCA saglayici basina tam yollar: callback (tarayici donusu) ve webhook.
#   PayTR'nin ok/fail donusu GET veya POST olabildigi icin PayTR'de callback'in GET'i de acilir.
#   Guven, sonucun saglayicidan SORGULANMASINDAN (iyzico token, PayTR durum sorgusu) ve imzali
#   bildirimden gelir; rota bazli throttling uygulanir. PayTR panelindeki "Bildirim URL":
#   `terraform output payments_callback_urls` -> paytr.webhook.
# - P4: PayTR "Platform Transfer Sonucu Bildirim URL": payments_callback_urls -> paytr.transfer_webhook.
#   Apartmanin aktarim alicisi (IBAN + hesap sahibi) musteri yonetimli KMS anahtariyla sifreli;
#   API Lambda yalnizca sifreler (kms:Encrypt), cozme (kms:Decrypt) yalnizca transferi gonderen
#   scheduler worker'da. Iki izin de `purpose = payment-payee` sifreleme baglamina kosullu.
# - Geri donen aktarim (PAYOUT_RETURNED) kritik alarm; yeniden gonderim/eslestirme hatasi
#   (PAYOUT_FAILED, PAYOUT_RETURN_UNMATCHED) alarm.
# - "Incelemeye alinan" odemeler (PAYMENT_NEEDS_REVIEW logu) alarm uretir.
# - Pazaryeri kalem onayi (iyzico approve) kalici basarisiz olursa (PAYMENT_APPROVAL_FAILED)
#   para iyzico havuzunda bekler, apartmana aktarilmaz: alarm uretir.
# ---------------------------------------------------------------------------

locals {
  # Yeni liste verilmisse o; yoksa eski tekil ayar (`disabled` = kapali).
  payment_providers = length(var.payments_providers) > 0 ? var.payments_providers : compact([var.payments_provider == "disabled" ? "" : var.payments_provider])
  payments_enabled  = length(local.payment_providers) > 0
  # Varsayilan verilmezse listedeki ilk saglayici.
  default_payment_provider = var.default_payment_provider != "" ? var.default_payment_provider : (local.payments_enabled ? local.payment_providers[0] : "")

  payment_public_routes = toset(flatten([
    for p in local.payment_providers : concat(
      ["POST /api/payments/${p}/callback", "POST /api/payments/${p}/webhook"],
      p == "paytr" ? ["GET /api/payments/paytr/callback", "POST /api/payments/paytr/transfer-webhook"] : [],
    )
  ]))

  payments_secret_arns = { for p, s in aws_secretsmanager_secret.payments : p => s.arn }

  # Odeme kapaliyken hicbir odeme degiskeni verilmez; saglayiciya ozgu degiskenler yalnizca o
  # saglayici aciksa verilir.
  payment_env_keys = concat(
    local.payments_enabled ? [
      "PAYMENTS_PROVIDERS", "DEFAULT_PAYMENT_PROVIDER", "PAYMENTS_API_BASE_URL", "WEB_APP_URL", "PAYMENTS_POS_RATE_BPS", "PAYMENTS_POS_FIXED_FEE_KURUS",
      "PAYEE_KMS_KEY_ID", "PLATFORM_INVOICE_MODE", "PLATFORM_INVOICE_VAT_BPS", "PLATFORM_INVOICE_VAT_MODE",
    ] : [],
    contains(local.payment_providers, "iyzico") ? ["IYZICO_BASE_URL", "IYZICO_SECRET_ARN"] : [],
    contains(local.payment_providers, "paytr") ? ["PAYTR_SECRET_ARN", "PAYTR_TEST_MODE", "PAYTR_TRANSFER_DELAY_HOURS"] : [],
  )

  # API Lambda ve scheduler worker ayni yapilandirmayi kullanir (config.ts).
  # `kosul ? {...} : {}` nesne tipleri uyusmadigi icin filtreli for ifadesi kullanilir.
  payments_env = {
    for k, v in {
      PAYMENTS_PROVIDERS       = join(",", local.payment_providers)
      DEFAULT_PAYMENT_PROVIDER = local.default_payment_provider
      PAYMENTS_API_BASE_URL    = aws_apigatewayv2_api.http.api_endpoint
      WEB_APP_URL              = var.web_app_url
      IYZICO_BASE_URL          = var.iyzico_base_url
      IYZICO_SECRET_ARN        = lookup(local.payments_secret_arns, "iyzico", "")
      PAYTR_SECRET_ARN         = lookup(local.payments_secret_arns, "paytr", "")
      PAYTR_TEST_MODE          = var.paytr_test_mode ? "1" : "0"
      # P4: aktarim alicisi sifreleme anahtari, PayTR transfer beklemesi, platform faturasi.
      PAYEE_KMS_KEY_ID           = local.payee_kms_key_arn
      PAYTR_TRANSFER_DELAY_HOURS = tostring(var.paytr_transfer_delay_hours)
      PLATFORM_INVOICE_MODE      = var.platform_invoice_mode
      PLATFORM_INVOICE_VAT_BPS   = tostring(var.platform_invoice_vat_bps)
      PLATFORM_INVOICE_VAT_MODE  = var.platform_invoice_vat_mode
      # P1: POS sozlesme orani (komisyon tahmini; hesap bazinda gecersiz kilinabilir).
      PAYMENTS_POS_RATE_BPS        = tostring(var.payments_pos_rate_bps)
      PAYMENTS_POS_FIXED_FEE_KURUS = tostring(var.payments_pos_fixed_fee_kurus)
    } : k => v if contains(local.payment_env_keys, k)
  }

  payment_jobs = {
    for k, v in {
      payment_reconcile = {
        cron        = "rate(15 minutes)"
        description = "15 dakikada bir - kaybolan callback/webhook icin bekleyen online odemeleri sonuclandir; vadesi gelen platform transferleri"
      }
      platform_invoices = {
        cron        = "cron(10 4 1 * ? *)"
        description = "Her ayin 1'i 04:10 - onceki donemin platform komisyon faturasi taslaklari"
      }
      # PayTR talimatlari 10:00'a kadar islenir; geri donenler ogleden sonra listelenir.
      payout_returns = {
        cron        = "cron(30 11 * * ? *)"
        description = "Her gun 11:30 - geri donen platform transferlerini esle (PAYOUT_RETURNED alarmi)"
      }
    } : k => v if local.payments_enabled && (k != "payout_returns" || contains(local.payment_providers, "paytr"))
  }

  payee_kms_key_arn = one(aws_kms_key.payee[*].arn)
}

# ---------------------------------------------------------------------------
# P4: aktarim alicisi (IBAN + hesap sahibi) sifreleme anahtari
# ---------------------------------------------------------------------------

# Musteri yonetimli simetrik anahtar; varsayilan anahtar politikasi (hesap koku) + rol IAM
# politikalari. Yillik otomatik anahtar dondurme acik; silme bekleme suresi prod'da 30 gun.
resource "aws_kms_key" "payee" {
  count = local.payments_enabled ? 1 : 0

  description             = "${local.name}: apartman aktarim alicisi (IBAN + hesap sahibi) sifreleme"
  key_usage               = "ENCRYPT_DECRYPT"
  enable_key_rotation     = true
  deletion_window_in_days = local.is_prod ? 30 : 7
}

resource "aws_kms_alias" "payee" {
  count = local.payments_enabled ? 1 : 0

  name          = "alias/${local.name}-payment-payee"
  target_key_id = aws_kms_key.payee[0].key_id
}

resource "aws_secretsmanager_secret" "payments" {
  for_each = toset(local.payment_providers)

  name = "${local.name}/payments/${each.key}"
  description = each.key == "paytr" ? (
    "PayTR magaza anahtarlari: {\"merchantId\",\"merchantKey\",\"merchantSalt\"}. Deger Terraform disinda girilir."
  ) : "iyzico anahtarlari: {\"apiKey\",\"secretKey\"}. Deger Terraform disinda girilir."
  # prod'da yanlislikla silinen anahtar 30 gun geri alinabilir; diger ortamlarda aninda silinir.
  recovery_window_in_days = local.is_prod ? 30 : 0

  lifecycle {
    precondition {
      condition     = var.web_app_url != ""
      error_message = "Online odeme acikken web_app_url zorunludur (odeme sonrasi donus adresi)."
    }
    precondition {
      condition     = contains(local.payment_providers, local.default_payment_provider)
      error_message = "default_payment_provider acik saglayicilardan (payments_providers) biri olmalidir."
    }
  }
}

# P3: tek saglayicili (count) secret saglayici anahtarli (for_each) yapiya tasindi; mevcut iyzico
# secret'i (ve degeri) yeniden olusturulmaz.
moved {
  from = aws_secretsmanager_secret.payments[0]
  to   = aws_secretsmanager_secret.payments["iyzico"]
}

# Kimliksiz odeme rotalari (daha ozel rota `ANY /api/{proxy+}` JWT rotasindan onceliklidir).
resource "aws_apigatewayv2_route" "payments_public" {
  for_each = local.payment_public_routes

  api_id             = aws_apigatewayv2_api.http.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "NONE"
}

# Incelemeye alinan odeme (saglayici basarili dedi ama dogrulama tutmadi / deftere yazilamadi).
resource "aws_cloudwatch_log_metric_filter" "payment_needs_review" {
  for_each = {
    for k, v in {
      api       = aws_cloudwatch_log_group.api.name
      scheduler = aws_cloudwatch_log_group.scheduler_worker.name
    } : k => v if local.payments_enabled
  }

  name           = "${local.name}-payment-needs-review-${each.key}"
  log_group_name = each.value
  pattern        = "\"PAYMENT_NEEDS_REVIEW\""

  metric_transformation {
    name      = "PaymentNeedsReview"
    namespace = "BuildingManagement/${local.name}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "payment_needs_review" {
  count = local.payments_enabled ? 1 : 0

  alarm_name          = "${local.name}-payment-needs-review"
  alarm_description   = "Saglayicinin onayladigi bir online odeme deftere yazilmadi (NEEDS_REVIEW). Para tahsil edilmis olabilir: niyet kaydini ve saglayici panelini kontrol edin."
  namespace           = "BuildingManagement/${local.name}"
  metric_name         = "PaymentNeedsReview"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  depends_on = [aws_cloudwatch_log_metric_filter.payment_needs_review]
}

# Platform ekibinin tam iade kararindan sonra saglayici iadeyi reddetti (PAYMENT_REFUND_FAILED):
# para sakinde degil; panelden kontrol edilip yeniden denenmeli.
resource "aws_cloudwatch_log_metric_filter" "payment_refund_failed" {
  for_each = {
    for k, v in {
      api       = aws_cloudwatch_log_group.api.name
      scheduler = aws_cloudwatch_log_group.scheduler_worker.name
    } : k => v if local.payments_enabled
  }

  name           = "${local.name}-payment-refund-failed-${each.key}"
  log_group_name = each.value
  pattern        = "\"PAYMENT_REFUND_FAILED\""

  metric_transformation {
    name      = "PaymentRefundFailed"
    namespace = "BuildingManagement/${local.name}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "payment_refund_failed" {
  count = local.payments_enabled ? 1 : 0

  alarm_name          = "${local.name}-payment-refund-failed"
  alarm_description   = "Platform ekibinin iade karari verdigi bir odemenin iadesi saglayici tarafindan reddedildi. Saglayici panelini kontrol edip /admin/payments ekranindan yeniden deneyin."
  namespace           = "BuildingManagement/${local.name}"
  metric_name         = "PaymentRefundFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  depends_on = [aws_cloudwatch_log_metric_filter.payment_refund_failed]
}

# Pazaryeri kalem onayi (iyzico /payment/iyzipos/item/approve) 10 denemede de basarisiz oldu ya da
# saglayici kalici olarak reddetti (PAYMENT_APPROVAL_FAILED): tahsilat defterde, ancak para alt uye
# isyerine (apartmana) aktarilmiyor. Saglayici panelinden kalemi kontrol edip onaylayin.
resource "aws_cloudwatch_log_metric_filter" "payment_approval_failed" {
  for_each = {
    for k, v in {
      api       = aws_cloudwatch_log_group.api.name
      scheduler = aws_cloudwatch_log_group.scheduler_worker.name
    } : k => v if local.payments_enabled
  }

  name           = "${local.name}-payment-approval-failed-${each.key}"
  log_group_name = each.value
  pattern        = "\"PAYMENT_APPROVAL_FAILED\""

  metric_transformation {
    name      = "PaymentApprovalFailed"
    namespace = "BuildingManagement/${local.name}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "payment_approval_failed" {
  count = local.payments_enabled ? 1 : 0

  alarm_name          = "${local.name}-payment-approval-failed"
  alarm_description   = "Bir online odemenin pazaryeri onayi kalici olarak basarisiz oldu: para saglayici havuzunda bekliyor, apartmana aktarilmiyor. Niyetin settlement kaydini ve saglayici panelini kontrol edin."
  namespace           = "BuildingManagement/${local.name}"
  metric_name         = "PaymentApprovalFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  depends_on = [aws_cloudwatch_log_metric_filter.payment_approval_failed]
}

# P4: banka aktarimi geri dondu (hatali IBAN / hesap adi): para saglayicida bekliyor, apartmana
# ulasmadi. KRITIK: platform ekibi duzeltilmis IBAN ile yeniden gondermeli (/admin/payments).
resource "aws_cloudwatch_log_metric_filter" "payout_returned" {
  for_each = {
    for k, v in {
      api       = aws_cloudwatch_log_group.api.name
      scheduler = aws_cloudwatch_log_group.scheduler_worker.name
    } : k => v if local.payments_enabled
  }

  name           = "${local.name}-payout-returned-${each.key}"
  log_group_name = each.value
  pattern        = "\"PAYOUT_RETURNED\""

  metric_transformation {
    name      = "PayoutReturned"
    namespace = "BuildingManagement/${local.name}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "payout_returned" {
  count = local.payments_enabled ? 1 : 0

  alarm_name          = "${local.name}-payout-returned"
  alarm_description   = "KRITIK: apartmana yapilan platform transferi banka tarafindan iade edildi (hatali IBAN / hesap adi). Para saglayicida bekliyor; /admin/payments aktarimlar listesinden duzeltilmis IBAN ile yeniden gonderin."
  namespace           = "BuildingManagement/${local.name}"
  metric_name         = "PayoutReturned"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  depends_on = [aws_cloudwatch_log_metric_filter.payout_returned]
}

# P4: yeniden gonderim reddedildi veya geri donen kayit bir aktarimla eslestirilemedi.
resource "aws_cloudwatch_log_metric_filter" "payout_failed" {
  for_each = {
    for k, v in {
      api       = aws_cloudwatch_log_group.api.name
      scheduler = aws_cloudwatch_log_group.scheduler_worker.name
    } : k => v if local.payments_enabled
  }

  name           = "${local.name}-payout-failed-${each.key}"
  log_group_name = each.value
  pattern        = "?\"PAYOUT_FAILED\" ?\"PAYOUT_RETURN_UNMATCHED\""

  metric_transformation {
    name      = "PayoutFailed"
    namespace = "BuildingManagement/${local.name}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "payout_failed" {
  count = local.payments_enabled ? 1 : 0

  alarm_name          = "${local.name}-payout-failed"
  alarm_description   = "Geri donen aktarimin yeniden gonderimi basarisiz oldu veya saglayicinin geri donen kaydi bir aktarimla eslestirilemedi. Saglayici panelini ve /admin/payments aktarimlar listesini kontrol edin."
  namespace           = "BuildingManagement/${local.name}"
  metric_name         = "PayoutFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  depends_on = [aws_cloudwatch_log_metric_filter.payout_failed]
}
