# ---------------------------------------------------------------------------
# Online odeme (Adim 8b): iyzico Checkout Form + Pazaryeri.
#
# Kod: apps/api/src/modules/payments (API Lambda + scheduler worker'daki payment_reconcile).
# - Anahtarlar Secrets Manager'da: Terraform yalnizca bos secret'i olusturur, DEGERI GIRMEZ
#   (state'e gizli bilgi yazilmaz). Deger elle girilir:
#     aws secretsmanager put-secret-value --secret-id <payments_secret_arn> \
#       --secret-string '{"apiKey":"sandbox-...","secretKey":"sandbox-..."}'
#   Lambda anahtari ilk istekte okur ve 5 dk bellekte tutar.
# - Kimliksiz rotalar YALNIZCA iki tam yol: saglayici callback'i (tarayici POST) ve webhook.
#   Guven, sonucun saglayicidan token ile SORGULANMASINDAN gelir; rota bazli throttling uygulanir.
# - "Incelemeye alinan" odemeler (PAYMENT_NEEDS_REVIEW logu) alarm uretir.
# - Pazaryeri kalem onayi (iyzico approve) kalici basarisiz olursa (PAYMENT_APPROVAL_FAILED)
#   para iyzico havuzunda bekler, apartmana aktarilmaz: alarm uretir.
# ---------------------------------------------------------------------------

locals {
  payments_enabled = var.payments_provider != "disabled"

  payment_public_routes = local.payments_enabled ? toset([
    "POST /api/payments/${var.payments_provider}/callback",
    "POST /api/payments/${var.payments_provider}/webhook",
  ]) : toset([])

  payments_secret_arn = one(aws_secretsmanager_secret.payments[*].arn)

  # API Lambda ve scheduler worker ayni yapilandirmayi kullanir (config.ts).
  # `kosul ? {...} : {}` nesne tipleri uyusmadigi icin filtreli for ifadesi kullanilir.
  payments_env = {
    for k, v in {
      # P2: kod birden fazla saglayici + varsayilan destekler (config.ts). Altyapi su an tek
      # saglayici acar (iyzico); PayTR P3'te kendi secret'i ve rotalariyla eklenecek.
      PAYMENTS_PROVIDERS       = var.payments_provider
      DEFAULT_PAYMENT_PROVIDER = var.payments_provider
      PAYMENTS_API_BASE_URL    = aws_apigatewayv2_api.http.api_endpoint
      WEB_APP_URL              = var.web_app_url
      IYZICO_BASE_URL          = var.iyzico_base_url
      IYZICO_SECRET_ARN        = local.payments_secret_arn
      # P1: POS sozlesme orani (komisyon tahmini; hesap bazinda gecersiz kilinabilir).
      PAYMENTS_POS_RATE_BPS        = tostring(var.payments_pos_rate_bps)
      PAYMENTS_POS_FIXED_FEE_KURUS = tostring(var.payments_pos_fixed_fee_kurus)
    } : k => v if local.payments_enabled
  }

  payment_jobs = {
    for k, v in {
      payment_reconcile = {
        cron        = "rate(15 minutes)"
        description = "15 dakikada bir - kaybolan callback/webhook icin bekleyen online odemeleri sonuclandir"
      }
    } : k => v if local.payments_enabled
  }
}

resource "aws_secretsmanager_secret" "payments" {
  count = local.payments_enabled ? 1 : 0

  name        = "${local.name}/payments/${var.payments_provider}"
  description = "Online odeme saglayicisi anahtarlari: {\"apiKey\",\"secretKey\"}. Deger Terraform disinda girilir."
  # prod'da yanlislikla silinen anahtar 30 gun geri alinabilir; diger ortamlarda aninda silinir.
  recovery_window_in_days = local.is_prod ? 30 : 0

  lifecycle {
    precondition {
      condition     = var.web_app_url != ""
      error_message = "Online odeme acikken web_app_url zorunludur (odeme sonrasi donus adresi)."
    }
  }
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
