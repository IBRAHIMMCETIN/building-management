# ---------------------------------------------------------------------------
# Domain olaylari: outbox-relay Lambda (outbox.tf; defter yazimlarinin olaylari) ve scheduler
# worker'i (DUES_REMINDER) -> SNS topic -> SQS (bildirim kuyrugu) -> worker (worker.tf).
#
# Uygulama (src/events/publisher.ts) her mesaja `eventType` ve `apartmentId` mesaj
# niteliklerini ekler; abonelik filtresi bunlara gore calisir. Raw delivery acik: SQS
# mesaj govdesi dogrudan olay JSON'udur (SNS zarfi yok).
#
# Olay payload'larinda kisisel veri yoktur; bu nedenle SNS'te KMS kullanilmadi.
# SQS kuyruklari SQS yonetimli sifreleme (SSE-SQS) ile korunur; SNS'in bu kuyruklara
# yazabilmesi icin aws/sqs KMS anahtari degil SSE-SQS gereklidir.
# ---------------------------------------------------------------------------

locals {
  # Bildirim worker'inin isledigi TUM olay turleri. apps/api/src/events/publisher.ts EVENT_TYPES ile
  # birebir ayni olmali (apps/api/test/notification-filter.test.ts denetler): listede olmayan tur
  # SNS'te sessizce elenir ve bildirim hic gitmez.
  notification_event_types = [
    "DUE_GENERATED", "PAYMENT_RECEIVED", "ANNOUNCEMENT_PUBLISHED", "LATE_FEE_POSTED", "DUES_REMINDER",
    "DUES_BATCH_SUMMARY", "METER_PERIOD_REVERSED",
    "TICKET_CREATED", "TICKET_ASSIGNED", "TICKET_STATUS_CHANGED", "TICKET_COMMENTED", "OPERATIONS_DIGEST",
    "POLL_PUBLISHED",
    "GATE_COURIER_ARRIVED", "GATE_GUEST_ENTERED",
    "RESERVATION_APPROVED", "RESERVATION_REJECTED", "RESERVATION_CANCELLED",
    "ASSEMBLY_CALLED",
    "TENDER_PUBLISHED", "TENDER_DECIDED", "TENDER_CANCELLED", "TENDER_REPLIED",
    "SUBSCRIPTION_TRIAL_ENDING", "SUBSCRIPTION_INVOICE_ISSUED", "SUBSCRIPTION_PAST_DUE", "SUBSCRIPTION_SUSPENDED", "SUBSCRIPTION_REACTIVATED", "SUBSCRIPTION_CANCELLED",
    "BULK_JOB_FINISHED",
    "RESTRUCTURE_REQUESTED", "RESTRUCTURE_APPROVED", "RESTRUCTURE_REJECTED",
  ]
  # Worker Lambda zaman asimi x 6 (AWS onerisi); worker 60 sn (worker.tf).
  notification_visibility_timeout = 360
}

resource "aws_sns_topic" "events" {
  name = "${local.name}-events"

  tags = { Name = "${local.name}-events" }
}

# ---------------------------------------------------------------------------
# Bildirim kuyrugu + DLQ
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "notification_dlq" {
  name                      = "${local.name}-notification-dlq"
  message_retention_seconds = 1209600 # 14 gun: incelemek ve yeniden islemek icin
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "notification" {
  name                       = "${local.name}-notification"
  visibility_timeout_seconds = local.notification_visibility_timeout
  message_retention_seconds  = 345600 # 4 gun
  receive_wait_time_seconds  = 20     # long polling
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.notification_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "notification_dlq" {
  queue_url = aws_sqs_queue.notification_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.notification.arn]
  })
}

data "aws_iam_policy_document" "notification_queue" {
  statement {
    sid     = "AllowEventsTopic"
    actions = ["sqs:SendMessage"]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    resources = [aws_sqs_queue.notification.arn]

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.events.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "notification" {
  queue_url = aws_sqs_queue.notification.id
  policy    = data.aws_iam_policy_document.notification_queue.json
}

resource "aws_sns_topic_subscription" "notification" {
  topic_arn            = aws_sns_topic.events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.notification.arn
  raw_message_delivery = true

  filter_policy_scope = "MessageAttributes"
  filter_policy = jsonencode({
    eventType = local.notification_event_types
  })

  # Kuyruk politikasi abonelikten once yazilmali; aksi halde ilk mesajlar reddedilir.
  depends_on = [aws_sqs_queue_policy.notification]
}

# ---------------------------------------------------------------------------
# Operasyon uyarilari: DLQ'ya dusen mesaj = kayip riski
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "notification_dlq" {
  alarm_name          = "${local.name}-notification-dlq-not-empty"
  alarm_description   = "Bildirim DLQ'sunda islenemeyen mesaj var."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.notification_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
