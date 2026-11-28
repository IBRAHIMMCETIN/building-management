# ---------------------------------------------------------------------------
# Bildirim devami: SES geri donus (bounce) / sikayet (complaint) geri bildirimleri.
#
# SES kimligi -> SNS `<yigin>-ses-feedback` -> bildirim worker'i (Lambda aboneligi, asenkron cagri;
# kod: apps/api/src/modules/notifications/suppressions.ts `handleSesFeedback`). Worker alici
# basina engel kaydi yazar (hash anahtar, neden, zaman; gecici geri donuse 7 gun TTL) ve e-posta
# kanali engelli aliciya gondermez. Platform yoneticisi `/admin/email-suppressions` ekranindan
# engeli kaldirir (denetimli).
#
# Worker yalnizca `SES_FEEDBACK_TOPIC_ARN` (bu topic) kayitlarini isler; asenkron cagri hatasi 2 denemeden
# sonra `<yigin>-ses-feedback-dlq` kuyruguna duser (alarm).
#
# Bu dosya YALNIZCA topic, topic politikasi (SES'in yayinlamasi, ayni hesap) ve aboneligi kurar;
# SES kimliginin bildirim ayari (bounce/complaint -> bu topic) SES canliya alininca ayrica yapilir
# (SES kimligi bu yiginda yonetilmez; dagitim politikasinda ses:SetIdentityNotificationTopic yok).
# Dagitim politikasi: sns:* ve lambda:* (AddPermission) yigin adlariyla zaten izinli.
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "ses_feedback" {
  name = "${local.name}-ses-feedback"

  tags = { Name = "${local.name}-ses-feedback" }
}

data "aws_iam_policy_document" "ses_feedback_topic" {
  statement {
    sid     = "AllowSesPublish"
    actions = ["sns:Publish"]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    resources = [aws_sns_topic.ses_feedback.arn]

    # Karisik vekil korumasi: yalnizca bu hesabin, bu bolgedeki SES kimlikleri / yapilandirma setleri.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "AWS:SourceArn"
      values = [
        "arn:${local.partition}:ses:${local.region}:${data.aws_caller_identity.current.account_id}:identity/*",
        "arn:${local.partition}:ses:${local.region}:${data.aws_caller_identity.current.account_id}:configuration-set/*",
      ]
    }
  }
}

# Asenkron (SNS -> Lambda) cagrisi 2 denemeden sonra da basarisizsa olay kaybolmasin: DLQ + alarm.
resource "aws_sqs_queue" "ses_feedback_dlq" {
  name                      = "${local.name}-ses-feedback-dlq"
  message_retention_seconds = 1209600 # 14 gun: incelemek ve yeniden islemek icin
  sqs_managed_sse_enabled   = true
}

# Yalnizca asenkron cagrilar (SES geri bildirim SNS aboneligi) icin gecerli; SQS olay kaynagi
# eslemesi senkron cagirir ve bu ayardan etkilenmez.
resource "aws_lambda_function_event_invoke_config" "notification_worker" {
  function_name          = aws_lambda_function.notification_worker.function_name
  maximum_retry_attempts = 2

  destination_config {
    on_failure {
      destination = aws_sqs_queue.ses_feedback_dlq.arn
    }
  }

  # Hedefe yazma yetkisi rol politikasinda (worker.tf `SesFeedbackDlq`).
  depends_on = [aws_iam_role_policy.notification_worker]
}

resource "aws_cloudwatch_metric_alarm" "ses_feedback_dlq" {
  alarm_name          = "${local.name}-ses-feedback-dlq-not-empty"
  alarm_description   = "SES geri donus / sikayet geri bildirimi islenemedi (e-posta engeli yazilamadi)."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.ses_feedback_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_sns_topic_policy" "ses_feedback" {
  arn    = aws_sns_topic.ses_feedback.arn
  policy = data.aws_iam_policy_document.ses_feedback_topic.json
}

resource "aws_lambda_permission" "ses_feedback" {
  statement_id  = "AllowSesFeedbackTopic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.notification_worker.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.ses_feedback.arn
}

resource "aws_sns_topic_subscription" "ses_feedback" {
  topic_arn = aws_sns_topic.ses_feedback.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.notification_worker.arn

  depends_on = [aws_lambda_permission.ses_feedback]
}

output "ses_feedback_topic_arn" {
  description = "SES kimliginin bounce / complaint bildirimlerinin yonlendirilecegi SNS topic'i (SES canliya alininca)."
  value       = aws_sns_topic.ses_feedback.arn
}
