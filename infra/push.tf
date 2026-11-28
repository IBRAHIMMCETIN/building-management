# ---------------------------------------------------------------------------
# Mobil bildirim (push, Expo). Kod: apps/api/src/modules/notifications/push.ts (notification worker)
# ve push-receipts.ts (scheduler `push_receipts` isi).
#
# - push_channel = expo: worker kayitli Expo cihazlarina gonderir (cihaz yoksa dis istek yok), scheduler
#   saatte bir makbuzlari kontrol eder. off: ikisi de yok.
# - Expo erisim anahtari ("Enhanced Security for Push Notifications" acilirsa zorunlu) Terraform'a ve
#   Lambda ortamina GIRMEZ: secret degersiz olusturulur, deger elle girilir:
#     aws secretsmanager put-secret-value --secret-id <expo_access_token_secret_arn> --secret-string '<anahtar>'
#   Deger girilmemisse istekler anahtarsiz gider. Worker / scheduler 5 dk onbellekle okur.
# - Expo'ya HTTPS cikisi: Lambda'lar VPC'de degil (varsayilan internet erisimi, NAT gerekmez).
# ---------------------------------------------------------------------------

locals {
  push_enabled = var.push_channel == "expo"

  # Worker ve scheduler ortak.
  push_env = merge(
    { PUSH_CHANNEL = var.push_channel },
    local.push_enabled ? { EXPO_ACCESS_TOKEN_SECRET_ARN = aws_secretsmanager_secret.expo_access_token[0].arn } : {},
  )
  # Yalnizca worker (karisik proje ayirimi).
  push_worker_env = merge(local.push_env, var.expo_project_id != "" ? { EXPO_PROJECT_ID = var.expo_project_id } : {})
}

resource "aws_secretsmanager_secret" "expo_access_token" {
  count = local.push_enabled ? 1 : 0

  name        = "${local.name}/push/expo-access-token"
  description = "Istege bagli Expo push erisim anahtari (duz metin veya {\"accessToken\"}). Deger Terraform disinda girilir; bos ise anahtarsiz gonderim."
  # prod'da yanlislikla silinen anahtar 30 gun geri alinabilir; diger ortamlarda aninda silinir.
  recovery_window_in_days = local.is_prod ? 30 : 0
}

# Kalici push hatasi (401/403 erisim anahtari, InvalidCredentials, MessageTooBig, kalici 4xx): bildirim
# gitmedi ve tekrar denenmeyecek. Ayrinti: notification-worker loglarinda msg=push_rejected (kod).
resource "aws_cloudwatch_metric_alarm" "push_rejected" {
  count = local.push_enabled ? 1 : 0

  alarm_name          = "${local.name}-push-rejected"
  alarm_description   = "Mobil bildirim kalici olarak reddedildi (Expo erisim anahtari / kimlik bilgisi / icerik). Ayrinti: notification-worker loglarinda msg=push_rejected."
  namespace           = local.metrics_namespace
  metric_name         = "PushRejected"
  dimensions          = local.metrics_dimensions
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Uzun Expo kesintisi: gecici hatayla tekrar denenen cihazlar art arda birikiyor (olaylar sonunda DLQ'ya
# duser; e-postalari gitmistir, DLQ'dan yeniden islemede yalnizca kalan push'lar gider).
resource "aws_cloudwatch_metric_alarm" "push_retry" {
  count = local.push_enabled ? 1 : 0

  alarm_name          = "${local.name}-push-retry"
  alarm_description   = "Mobil bildirimler gecici Expo hatalariyla tekrar deneniyor (kesinti / kisitlama). Ayrinti: notification-worker loglarinda msg=event_failed, TransientPushError."
  namespace           = local.metrics_namespace
  metric_name         = "PushRetried"
  dimensions          = local.metrics_dimensions
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 2
  threshold           = 25
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Expo makbuzlarinda olu cihaz (DeviceNotRegistered) disindaki hatalar: InvalidCredentials (APNs / FCM
# anahtari), MessageTooBig, MessageRateExceeded... Gonderim kabul edilmis ama cihaza ulasmamistir;
# yapilandirma / icerik sorunudur. Scheduler `push_receipts` isi (saatte bir) tek satir yazar:
#   {"level":"error","msg":"push_receipt_errors","errors":{"<kod>":<adet>}}
resource "aws_cloudwatch_log_metric_filter" "push_receipt_errors" {
  count = local.push_enabled ? 1 : 0

  name           = "${local.name}-push-receipt-errors"
  log_group_name = aws_cloudwatch_log_group.scheduler_worker.name
  pattern        = "\"push_receipt_errors\""

  metric_transformation {
    name      = "PushReceiptErrors"
    namespace = "BuildingManagement/${local.name}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "push_receipt_errors" {
  count = local.push_enabled ? 1 : 0

  alarm_name          = "${local.name}-push-receipt-errors"
  alarm_description   = "Expo push makbuzlarinda olu cihaz disinda hata var (APNs / FCM kimlik bilgisi, icerik boyutu, kisitlama): bildirimler cihaza ulasmamis olabilir. Ayrinti: scheduler-worker loglarinda msg=push_receipt_errors (hata kodu ve adedi)."
  namespace           = "BuildingManagement/${local.name}"
  metric_name         = "PushReceiptErrors"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  depends_on = [aws_cloudwatch_log_metric_filter.push_receipt_errors]
}
