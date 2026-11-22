# ---------------------------------------------------------------------------
# Operasyon metrikleri ve platform alarmlari (Asama 3).
#
# Kaynak: zamanlayici worker'i (scheduler-worker.ts) CloudWatch Embedded Metric Format ile log
# satiri yazar; CloudWatch Logs bunlari `BuildingManagement` namespace'inde, `Stack = <yigin adi>`
# boyutuyla metrige donusturur (PutMetricData yetkisi gerekmez). Alarmlar yalnizca platform
# uyari topic'ine gider (`alerts`); site yoneticisi arayuzune hicbir sey yansimaz.
#
#   LedgerDrift                 ledger_audit bulgu sayisi (apartman basina, gecelik)
#   LedgerAuditUnstable         es zamanli yazim nedeniyle sonuca varilamayan bakiye kontrolu
#   OutboxSweepFailed           suprucunun yayinlayamadigi olay sayisi
#   OutboxOldestPendingSeconds  suprucu turunda en eski bekleyen olayin yasi
#   BankReconDiff               (Faz B3) ledger_audit: banka ekstresi kapanisi <-> defter banka bakiyesi
#                               farkinin bekleyen (eslesmemis) satirlarla ACIKLANAMAYAN kismi, kurus,
#                               apartman basina mutlak toplam (birim None)
#   BankReconAccountsOff        (Faz B3) aciklanamayan farki olan banka hesabi sayisi
# ---------------------------------------------------------------------------

locals {
  metrics_namespace  = "BuildingManagement"
  metrics_dimensions = { Stack = local.name }
}

# Defterde tutarsizlik: otomatik duzeltme YOK (append-only); inceleme + ters kayit gerekir.
resource "aws_cloudwatch_metric_alarm" "ledger_drift" {
  alarm_name          = "${local.name}-ledger-drift"
  alarm_description   = "Gecelik defter denetimi sapma buldu (bakiye/denge/kapama kilidi/online odeme). Ayrinti: scheduler-worker loglarinda msg=ledger_audit. Duzeltme yalnizca ters kayitla."
  namespace           = local.metrics_namespace
  metric_name         = "LedgerDrift"
  dimensions          = local.metrics_dimensions
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Suprucu ust uste iki pencerede olay yayinlayamiyor (SNS / yetki sorunu).
resource "aws_cloudwatch_metric_alarm" "outbox_sweep_failed" {
  alarm_name          = "${local.name}-outbox-sweep-failed"
  alarm_description   = "Outbox suprucusu olaylari yayinlayamiyor; bildirimler gecikiyor (kayitlar bekleyen kalir, kayip yok)."
  namespace           = local.metrics_namespace
  metric_name         = "OutboxSweepFailed"
  dimensions          = local.metrics_dimensions
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Bekleyen olaylar 15 dakikayi asan surede kaliyor: relay ve suprucu birlikte geride.
resource "aws_cloudwatch_metric_alarm" "outbox_stuck" {
  alarm_name          = "${local.name}-outbox-stuck"
  alarm_description   = "En eski bekleyen outbox olayi 15 dakikadan eski (relay ve suprucu yayinlayamiyor)."
  namespace           = local.metrics_namespace
  metric_name         = "OutboxOldestPendingSeconds"
  dimensions          = local.metrics_dimensions
  statistic           = "Maximum"
  period              = 900
  evaluation_periods  = 2
  threshold           = 900
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Banka mutabakati (Faz B3): ekstre kapanis bakiyesi ile defterdeki banka hesabi bakiyesi arasinda,
# bekleyen satirlarla aciklanamayan fark (yoksayilip deftere islenmemis masraf, bankaya yansimamis
# elle kayit, eksik ekstre...). Defter tutarsizligi DEGILDIR (LedgerDrift'ten ayri): veri kalitesi
# sinyali; esik varsayilan 0 kurus, `bank_recon_diff_alarm_threshold` ile gevsetilebilir.
# Gunluk metrik (gece denetimi): 1 gunluk pencere.
resource "aws_cloudwatch_metric_alarm" "bank_recon_diff" {
  alarm_name          = "${local.name}-bank-recon-diff"
  alarm_description   = "Gece denetiminde banka ekstresi ile defter arasinda bekleyen satirlarla aciklanamayan fark (kurus) ${var.bank_recon_diff_alarm_threshold} uzerinde. Ayrinti: scheduler-worker loglarinda msg=bank_recon_metrics (apartman, hesap, unexplainedDiff)."
  namespace           = local.metrics_namespace
  metric_name         = "BankReconDiff"
  dimensions          = local.metrics_dimensions
  statistic           = "Maximum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = var.bank_recon_diff_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
