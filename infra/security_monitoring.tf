# ---------------------------------------------------------------------------
# Guvenlik izleme: hassas rotalarda throttling + guvenlik alarmlari (alerts SNS topic'i).
#
# Throttling (API Gateway HTTP API) ROTA basinadir, istemci basina DEGILDIR: arka ucu ve
# maliyeti (Cognito, SES, toplu yazim) korur; kullanici bazli kaba kuvvete karsi koruma Cognito'nun
# kendi deneme sinirlarindan ve asagidaki alarmlardan gelir. Giris (SRP) dogrudan Cognito'ya
# gider, API Gateway'den gecmez: LITE katmaninda tehdit korumasi yoktur, yalnizca izlenir.
#
# Metrikler:
#   AWS/Cognito  SignInSuccesses   basarisiz giris = SampleCount - Sum (basarisiz deneme 0
#                                  degerli veri noktasi uretir; kisitlanan istek de basarisiz)
#   AWS/ApiGateway 5xx             HTTP API stage (ApiId, Stage)
#   BuildingManagement (EMF, Stack boyutu; API ve scheduler worker log satirlarindan):
#     MfaVerifyFailed    TOTP kurulum dogrulamasinda hatali kod
#     MfaReset           yonetici MFA sifirlamasi
#     MfaRequiredDenied  MFA'siz yetkili istek (403 MFA_REQUIRED) - yalnizca panelde izlenir
#     AuditChainBroken   gece denetiminde hash zinciri bulgusu
#     AuditRun           gece denetimi kalp atisi (her calismada 1)
# ---------------------------------------------------------------------------

locals {
  # Hassas uclar: ayri JWT rotalari (ayni Lambda entegrasyonu) + daha siki rota sinirlari.
  # Daha ozel rota `ANY /api/{proxy+}`'den once eslesir; yetki kontrolu uygulamada degismez.
  # Faz B1: banka ekstresi uclari (S3 okuma, KMS GenerateMac, toplu satir yazimi) toplu yazim sinirinda.
  # Faz B3: toplu otomatik eslestirme (istek basina 25 satira kadar atomik defter yazimi) da ayni grupta.
  # Faz B3.5: donemsel mutabakat PDF'i (istek aninda pdf-lib ile uretim + S3) da ayni grupta.
  sensitive_routes = {
    "POST /api/me/mfa/totp/setup"                        = { rate = var.mfa_route_rate_limit, burst = var.mfa_route_burst_limit }
    "POST /api/me/mfa/totp/verify"                       = { rate = var.mfa_route_rate_limit, burst = var.mfa_route_burst_limit }
    "POST /api/mfa/users/{userId}/reset"                 = { rate = var.security_admin_route_rate_limit, burst = var.security_admin_route_burst_limit }
    "POST /api/support/sessions"                         = { rate = var.security_admin_route_rate_limit, burst = var.security_admin_route_burst_limit }
    "POST /api/residents/invite"                         = { rate = var.bulk_write_route_rate_limit, burst = var.bulk_write_route_burst_limit }
    "POST /api/finance/dues"                             = { rate = var.bulk_write_route_rate_limit, burst = var.bulk_write_route_burst_limit }
    "POST /api/imports"                                  = { rate = var.bulk_write_route_rate_limit, burst = var.bulk_write_route_burst_limit }
    "POST /api/bank/statements/upload-url"               = { rate = var.bulk_write_route_rate_limit, burst = var.bulk_write_route_burst_limit }
    "POST /api/bank/statements"                          = { rate = var.bulk_write_route_rate_limit, burst = var.bulk_write_route_burst_limit }
    "POST /api/bank/statements/{statementId}/commit"     = { rate = var.bulk_write_route_rate_limit, burst = var.bulk_write_route_burst_limit }
    "POST /api/bank/statements/{statementId}/auto-match" = { rate = var.bulk_write_route_rate_limit, burst = var.bulk_write_route_burst_limit }
    "GET /api/bank/reconciliation/report"                = { rate = var.bulk_write_route_rate_limit, burst = var.bulk_write_route_burst_limit }
  }
}

resource "aws_apigatewayv2_route" "sensitive" {
  for_each = local.sensitive_routes

  api_id             = aws_apigatewayv2_api.http.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

# ---------------------------------------------------------------------------
# Alarmlar
# ---------------------------------------------------------------------------

# Basarisiz giris artisi (parola denemesi, TOTP hatasi, kisitlanan istek): kaba kuvvet / credential
# stuffing belirtisi. Inceleme: Cognito kullanici etkinligi, kaynak IP'ler.
resource "aws_cloudwatch_metric_alarm" "cognito_signin_failures" {
  alarm_name          = "${local.name}-signin-failures"
  alarm_description   = "Cognito'da 5 dakikada ${var.signin_failure_alarm_threshold}+ basarisiz giris (SignInSuccesses SampleCount - Sum). Kaba kuvvet veya credential stuffing olabilir."
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.signin_failure_alarm_threshold
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "failures"
    expression  = "attempts - successes"
    label       = "Basarisiz giris"
    return_data = true
  }

  metric_query {
    id = "attempts"
    metric {
      namespace   = "AWS/Cognito"
      metric_name = "SignInSuccesses"
      dimensions  = { UserPool = aws_cognito_user_pool.main.id, UserPoolClient = aws_cognito_user_pool_client.web.id }
      stat        = "SampleCount"
      period      = 300
    }
  }

  metric_query {
    id = "successes"
    metric {
      namespace   = "AWS/Cognito"
      metric_name = "SignInSuccesses"
      dimensions  = { UserPool = aws_cognito_user_pool.main.id, UserPoolClient = aws_cognito_user_pool_client.web.id }
      stat        = "Sum"
      period      = 300
    }
  }
}

# TOTP kurulumunda art arda hatali kod (ele gecirilmis oturumla kurulum denemesi olabilir).
resource "aws_cloudwatch_metric_alarm" "mfa_verify_failed" {
  alarm_name          = "${local.name}-mfa-verify-failed"
  alarm_description   = "5 dakikada ${var.mfa_verify_failure_alarm_threshold}+ hatali TOTP dogrulama kodu (MFA kurulumu). Ayrinti: API loglarinda msg=mfa_verify_failed."
  namespace           = local.metrics_namespace
  metric_name         = "MfaVerifyFailed"
  dimensions          = local.metrics_dimensions
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.mfa_verify_failure_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Olagandisi sayida MFA sifirlama (ele gecirilmis yonetici hesabi belirtisi olabilir).
resource "aws_cloudwatch_metric_alarm" "mfa_reset_spike" {
  alarm_name          = "${local.name}-mfa-reset-spike"
  alarm_description   = "1 saatte ${var.mfa_reset_alarm_threshold}+ MFA sifirlama. Denetim gunlugunde mfa.reset kayitlarini (yapan, gerekce) inceleyin."
  namespace           = local.metrics_namespace
  metric_name         = "MfaReset"
  dimensions          = local.metrics_dimensions
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = var.mfa_reset_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# API Gateway 5xx (Lambda hatasi, zaman asimi, entegrasyon hatasi).
resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name}-api-5xx"
  alarm_description   = "API Gateway 5 dakikada ${var.api_5xx_alarm_threshold}+ 5xx yanit. Ayrinti: API erisim logu (status, integrationErr) ve API Lambda loglari."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = aws_apigatewayv2_api.http.id, Stage = aws_apigatewayv2_stage.default.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.api_5xx_alarm_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Denetim gunlugu hash zinciri bozuk (ustune yazma, silme, bag kopmasi). LedgerDrift'e de
# sayilir; bu alarm ayri runbook icindir: kayit degistirilemez, yalnizca incelenir.
resource "aws_cloudwatch_metric_alarm" "audit_chain_broken" {
  alarm_name          = "${local.name}-audit-chain-broken"
  alarm_description   = "Gece denetimi denetim gunlugu zincirinde bulgu buldu (audit_chain_*). Ayrinti: scheduler-worker loglarinda msg=ledger_audit. Kontrol noktasi bulgu giderilene kadar ilerlemez."
  namespace           = local.metrics_namespace
  metric_name         = "AuditChainBroken"
  dimensions          = local.metrics_dimensions
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Gece denetimi hic calismadi (zamanlayici, kuyruk veya worker sorunu). Zamanlamalar kapaliyken
# (scheduler_enabled = false) kurulmaz; aksi halde surekli alarm verirdi.
resource "aws_cloudwatch_metric_alarm" "audit_run_missing" {
  count = var.scheduler_enabled ? 1 : 0

  alarm_name          = "${local.name}-audit-run-missing"
  alarm_description   = "Son 24 saatte gece denetimi (ledger_audit) tamamlanmadi: defter ve denetim zinciri dogrulanmiyor. Zamanlayici, gorev kuyrugu/DLQ ve scheduler-worker loglarini kontrol edin."
  namespace           = local.metrics_namespace
  metric_name         = "AuditRun"
  dimensions          = local.metrics_dimensions
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
