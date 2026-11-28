# ---------------------------------------------------------------------------
# Bildirim devami: SES geri donus (bounce) / sikayet (complaint) geri bildirimleri.
#
# SES kimligi -> SNS `<yigin>-ses-feedback` -> bildirim worker'i (Lambda aboneligi, asenkron cagri;
# kod: apps/api/src/modules/notifications/suppressions.ts `handleSesFeedback`). Worker alici
# basina engel kaydi yazar (hash anahtar, neden, zaman; gecici geri donuse 7 gun TTL) ve e-posta
# kanali engelli aliciya gondermez. Platform yoneticisi `/admin/email-suppressions` ekranindan
# engeli kaldirir (denetimli).
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

    # Karisik vekil korumasi: yalnizca bu hesabin SES kimlikleri.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
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
