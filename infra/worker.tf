# ---------------------------------------------------------------------------
# Bildirim worker'i: notification SQS kuyrugu -> Lambda (event source mapping).
#
# Kod: apps/api/src/workers/notification-worker.ts (build:lambda -> notification-worker.mjs)
# - Kismi toplu hata bildirimi (ReportBatchItemFailures): yalnizca basarisiz mesajlar
#   yeniden denenir; 5 denemeden sonra DLQ'ya duser (sns_sqs.tf) ve alarm calar.
# - Es zamanli calisma 2 ile sinirli: SMS/WhatsApp saglayicilarinin hiz sinirlarini asmamak
#   ve DynamoDB'yi korumak icin.
# - Kuyruk gorunurluk zaman asimi (360 sn) = 6 x Lambda zaman asimi (60 sn): AWS onerisi. 60 sn:
#   bir SQS partisinde (10 olay) e-posta + Expo push parcalari (100 mesaj / istek, istek basina en
#   fazla 10 sn) icin pay.
# - Mobil bildirim (push_channel = expo): Expo push API'sine (exp.host) giden HTTPS. Lambda VPC'ye
#   baglanmaz (vpc_config yok): AWS'nin varsayilan internet cikisi kullanilir, NAT gerekmez.
# ---------------------------------------------------------------------------

locals {
  worker_function        = "${local.name}-notification-worker"
  worker_timeout_seconds = 60

  # E-posta kanali (Asama 4): gonderen adres, alan adi ve SES izin kapsamlari.
  notification_ses         = var.notification_channel == "ses"
  notification_from_email  = lower(length(regexall("<([^<>]+)>", var.notification_from_address)) > 0 ? regex("<([^<>]+)>", var.notification_from_address)[0] : trimspace(var.notification_from_address))
  notification_from_domain = element(split("@", local.notification_from_email), 1)
  notification_ses_resources = compact([
    local.notification_ses ? var.ses_identity_arn : "",
    local.notification_ses && var.ses_configuration_set != "" ? "arn:${local.partition}:ses:${local.region}:${data.aws_caller_identity.current.account_id}:configuration-set/${var.ses_configuration_set}" : "",
  ])
  notification_env = merge(
    {
      NOTIFICATION_CHANNEL = var.notification_channel
      SES_FROM_ADDRESS     = var.notification_from_address
      # Bildirim devami: yalnizca bu topic'ten gelen SES geri bildirimleri islenir (ses_feedback.tf).
      SES_FEEDBACK_TOPIC_ARN = aws_sns_topic.ses_feedback.arn
    },
    var.ses_configuration_set != "" ? { SES_CONFIGURATION_SET = var.ses_configuration_set } : {},
    local.web_app_url != "" ? { WEB_APP_URL = local.web_app_url } : {},
  )
}

resource "aws_cloudwatch_log_group" "notification_worker" {
  name              = "/aws/lambda/${local.worker_function}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "notification_worker" {
  name               = local.worker_function
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "notification_worker" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.notification_worker.arn}:*"]
  }

  # Okuma: uyelikler, daireler, kisi (e-posta), ekip kayitlari (talep bildirimi alicilari ve kisi
  # kaydi olmayan ekip uyesinin yedek e-postasi), kullanici tercihi ve push cihazlari. Yazma: NOTIF#
  # isleme kaydi, NOTIFSENT# / NOTIFPUSH# gonderim kayitlari ve PUSHRCPT# makbuz kovalari. Silme yok.
  statement {
    sid       = "DynamoDb"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.main.arn]
  }

  # Push: olu / yabanci cihazi pasife alma ve sahiplik kaydina TTL. Yalnizca USER# / PUSHTOKEN#
  # bolumleri; apartman verisini guncelleyemez.
  dynamic "statement" {
    for_each = local.push_enabled ? [1] : []
    content {
      sid       = "PushDeviceUpdate"
      actions   = ["dynamodb:UpdateItem"]
      resources = [aws_dynamodb_table.main.arn]

      condition {
        test     = "ForAllValues:StringLike"
        variable = "dynamodb:LeadingKeys"
        values   = ["USER#*", "PUSHTOKEN#*"]
      }
    }
  }

  # Expo erisim anahtari (push.tf): yalnizca bu secret.
  dynamic "statement" {
    for_each = local.push_enabled ? [1] : []
    content {
      sid       = "ReadExpoAccessToken"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [aws_secretsmanager_secret.expo_access_token[0].arn]
    }
  }

  # SES geri bildirim asenkron cagrisinin basarisizlik hedefi (ses_feedback.tf): yalnizca SendMessage.
  statement {
    sid       = "SesFeedbackDlq"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.ses_feedback_dlq.arn]
  }

  statement {
    sid = "ConsumeQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.notification.arn]
  }

  # E-posta: yalnizca dogrulanmis SES kimligi (ve varsa yapilandirma seti) uzerinden, yalnizca
  # yapilandirilmis gonderen adresle. Kanal `log` iken SES yetkisi yok.
  dynamic "statement" {
    for_each = local.notification_ses ? [1] : []
    content {
      sid       = "SendNotificationEmail"
      actions   = ["ses:SendEmail", "ses:SendRawEmail"]
      resources = local.notification_ses_resources

      condition {
        test     = "StringEqualsIgnoreCase"
        variable = "ses:FromAddress"
        values   = [local.notification_from_email]
      }
    }
  }
}

resource "aws_iam_role_policy" "notification_worker" {
  name   = "notification-worker"
  role   = aws_iam_role.notification_worker.id
  policy = data.aws_iam_policy_document.notification_worker.json
}

resource "aws_lambda_function" "notification_worker" {
  function_name    = local.worker_function
  description      = "SQS bildirim kuyrugu tuketicisi: e-posta / log ve Expo mobil bildirim (push)"
  role             = aws_iam_role.notification_worker.arn
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  handler          = "notification-worker.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = local.worker_timeout_seconds

  environment {
    variables = merge({
      NODE_ENV            = "production"
      DYNAMODB_TABLE_NAME = aws_dynamodb_table.main.name
      # EMF metriklerinin `Stack` boyutu (push.tf alarmlari ayni degeri bekler).
      METRICS_STACK = local.name
    }, local.notification_env, local.push_worker_env)
  }

  depends_on = [
    aws_cloudwatch_log_group.notification_worker,
    aws_iam_role_policy.notification_worker,
  ]

  lifecycle {
    precondition {
      condition     = local.notification_visibility_timeout >= 6 * local.worker_timeout_seconds
      error_message = "Kuyruk gorunurluk zaman asimi worker zaman asiminin en az 6 kati olmali."
    }
    # SES kimligi gonderen adresin alan adini veya adresini kapsamali (aksi halde SES reddeder).
    precondition {
      condition = !local.notification_ses || (
        var.ses_identity_arn != "" && (
          endswith(var.ses_identity_arn, "identity/${local.notification_from_domain}") ||
          endswith(var.ses_identity_arn, "identity/${local.notification_from_email}")
        )
      )
      error_message = "notification_channel=ses icin ses_identity_arn, notification_from_address alan adini (veya adresini) kapsayan dogrulanmis SES kimligi olmalidir."
    }
  }
}

resource "aws_lambda_event_source_mapping" "notification" {
  event_source_arn                   = aws_sqs_queue.notification.arn
  function_name                      = aws_lambda_function.notification_worker.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5
  function_response_types            = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2
  }

  # Rol politikasi yazilmadan eslestirme olusturulursa kuyruk erisimi reddedilir.
  depends_on = [aws_iam_role_policy.notification_worker]
}

resource "aws_cloudwatch_metric_alarm" "notification_worker_errors" {
  alarm_name          = "${local.worker_function}-errors"
  alarm_description   = "Bildirim worker'i hata veriyor (5 dakikada 5+ hata)."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.notification_worker.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Islenmeyi bekleyen mesajlar birikiyorsa (worker durmus / yavas) uyari.
resource "aws_cloudwatch_metric_alarm" "notification_queue_age" {
  alarm_name          = "${local.name}-notification-queue-stale"
  alarm_description   = "Bildirim kuyrugundaki en eski mesaj 15 dakikadan eski."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.notification.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 900
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
