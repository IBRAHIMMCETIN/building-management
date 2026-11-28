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
#   LedgerAuditDurationMs       (Adim 2-2) site basina ledger_audit suresi (ms); fan-out sonrasi her site
#                               ayri Lambda cagrisinda, sinir scheduler worker zaman asimi
#   LedgerAuditSiteFailed       (Adim 2-2) site denetimi hata verdi (1) / basarili (0)
#   LedgerAuditFanout           (Adim 2-2) tur mesajinin kuyruga biraktigi site mesaji sayisi
#   GateDepartureFailed         maintenance_tasks: tasinanin gecis / araclarini pasife alma adimi
#                               bir aday icin basarisiz (okuma anindaki kontrol guvenlik agidir)
# ---------------------------------------------------------------------------

locals {
  metrics_namespace  = "BuildingManagement"
  metrics_dimensions = { Stack = local.name }

  # Adim 2-2: tek site denetimi worker zaman asiminin %60'ini asarsa uyari (buyuyen site erken gorulur).
  ledger_audit_duration_alarm_ms = floor(local.scheduler_timeout_seconds * 1000 * 0.6)
}

# Adim 2-2: site basina gece denetimi hata verdi (SQS yeniden dener; 5 denemeden sonra DLQ alarmi).
resource "aws_cloudwatch_metric_alarm" "ledger_audit_site_failed" {
  alarm_name          = "${local.name}-ledger-audit-site-failed"
  alarm_description   = "Bir sitenin gece defter denetimi (ledger_audit) hata verdi. Ayrinti: scheduler-worker loglarinda msg=ledger_audit_site (apartmentId, error). Mesaj otomatik yeniden denenir."
  namespace           = local.metrics_namespace
  metric_name         = "LedgerAuditSiteFailed"
  dimensions          = local.metrics_dimensions
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Adim 2-2: tek sitenin denetimi worker zaman asimina yaklasiyor (site buyudukce okuma sinirlanmali).
resource "aws_cloudwatch_metric_alarm" "ledger_audit_slow" {
  alarm_name          = "${local.name}-ledger-audit-slow"
  alarm_description   = "Bir sitenin gece defter denetimi worker zaman asiminin %60'ini asti. Ayrinti: scheduler-worker loglarinda msg=ledger_audit_duration."
  namespace           = local.metrics_namespace
  metric_name         = "LedgerAuditDurationMs"
  dimensions          = local.metrics_dimensions
  statistic           = "Maximum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = local.ledger_audit_duration_alarm_ms
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
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

# Tasinmada gecis / arac pasife alma adimi basarisiz (gunluk maintenance_tasks). Kapi kararlari okuma
# aninda uyelikten verildigi icin guvenlik acigi degil; kayitlar aktif gorunmeye devam eder.
resource "aws_cloudwatch_metric_alarm" "gate_departure_failed" {
  alarm_name          = "${local.name}-gate-departure-failed"
  alarm_description   = "Tasinan sakinin kapi gecis / araclarini pasife alma adimi basarisiz oldu. Ayrinti: scheduler-worker loglarinda msg=gate_departure_failed (apartman, bolum). Sonraki gunluk calisma tekrar dener."
  namespace           = local.metrics_namespace
  metric_name         = "GateDepartureFailed"
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
