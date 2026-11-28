# ---------------------------------------------------------------------------
# Zamanlanmis gorevler: EventBridge Scheduler -> SQS (scheduled-jobs) -> scheduler worker.
#
# Kod: apps/api/src/workers/scheduler-worker.ts (build:lambda -> scheduler-worker.mjs)
# - Scheduler dogrudan is yapmaz; kuyruga `{ job, scheduledTime }` birakir. scheduledTime
#   Scheduler'in PLANLANAN zamanidir; is gunu/donem bundan Istanbul saatine gore turetilir.
# - Zaman dilimi Europe/Istanbul (yaz/kis saati degisse bile yerel saatte calisir).
# - Isler idempotenttir (donem bazli defter anahtarlari, deterministik olay kimlikleri);
#   SQS'in tekrar teslimi veya elle yeniden calistirma ayni ayi iki kez borclandirmaz.
# - Hata: 5 denemeden sonra DLQ + alarm.
# ---------------------------------------------------------------------------

locals {
  scheduler_function        = "${local.name}-scheduler-worker"
  scheduler_timeout_seconds = 300

  # Lambda zaman asimi x 6 (AWS onerisi).
  jobs_visibility_timeout = 6 * 300

  # Gecikme tazminati yeni ayin aidatindan ONCE kesinlestirilir.
  scheduled_jobs = {
    late_fees = {
      cron        = "cron(30 2 1 * ? *)"
      description = "Her ayin 1'i 02:30 - onceki ayin gecikme tazminatini kesinlestir"
    }
    monthly_dues = {
      cron        = "cron(0 3 1 * ? *)"
      description = "Her ayin 1'i 03:00 - aylik aidat planini tahakkuk et"
    }
    dues_reminders = {
      cron        = "cron(0 10 * * ? *)"
      description = "Her gun 10:00 - vadeden 3 gun once, 1 ve 7 gun sonra borc hatirlatmasi"
    }
    # Transactional outbox suprucusu ve gecelik defter denetimi (operations.tf alarmlari).
    outbox_sweep = {
      cron        = "rate(5 minutes)"
      description = "5 dakikada bir - esikten eski, hala bekleyen outbox olaylarini yeniden yayinla"
    }
    ledger_audit = {
      cron        = "cron(40 3 * * ? *)"
      description = "Her gun 03:40 - salt okunur defter denetimi (sapma -> LedgerDrift metrigi + alarm)"
    }
    # Finans 2.2: taksit plani temerrut (muacceliyet) taramasi; bildirim outbox ile (DUES_REMINDER).
    installment_plans = {
      cron        = "cron(30 9 * * ? *)"
      description = "Her gun 09:30 - taksit planlarinda temerrut tespiti, bildirim ve (plan ayarina gore) muacceliyet"
    }
    # Faz 3 (O1-3): periyodik bakim gorevi uretimi (silme yok; gorev anahtari idempotent).
    maintenance_tasks = {
      cron        = "cron(10 4 * * ? *)"
      description = "Her gun 04:10 - aktif bakim sablonlarinin yaklasan gorevlerini olustur"
    }
    # Faz 3 (O1-3): onaylanmayan cozumu otomatik kapat + gunluk ariza/bakim ozeti (OPERATIONS_DIGEST).
    ticket_maintenance = {
      cron        = "cron(30 7 * * ? *)"
      description = "Her gun 07:30 - onaylanmayan cozulmus talepleri kapat, SLA ve bakim ozetini gonder"
    }
    # Abonelik / lisans: deneme bitisi, donem faturasi, gecikme -> ek sure -> askiya alma (idempotent).
    subscriptions = {
      cron        = "cron(15 6 * * ? *)"
      description = "Her gun 06:15 - abonelik durum makinesi: deneme bitisi, donem faturasi, gecikme ve askiya alma"
    }
  }

  # Mobil bildirim (push_channel = expo): Expo push makbuzlari; olu cihazlar (DeviceNotRegistered)
  # pasife alinir. Expo HTTPS cikisi: Lambda VPC'de degil (varsayilan internet erisimi).
  push_jobs = local.push_enabled ? {
    push_receipts = {
      cron        = "cron(20 * * * ? *)"
      description = "Saatte bir :20 - Expo push makbuzlarini kontrol et, kaldirilmis uygulamalarin cihazlarini pasife al"
    }
  } : {}

  # Suprucu bu yastan genc outbox kayitlarina dokunmaz (relay'e birakir).
  outbox_sweep_min_age_seconds = 120
}

# ---------------------------------------------------------------------------
# Kuyruk + DLQ
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "jobs_dlq" {
  name                      = "${local.name}-scheduled-jobs-dlq"
  message_retention_seconds = 1209600 # 14 gun
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${local.name}-scheduled-jobs"
  visibility_timeout_seconds = local.jobs_visibility_timeout
  message_retention_seconds  = 345600 # 4 gun
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "jobs_dlq" {
  queue_url = aws_sqs_queue.jobs_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.jobs.arn]
  })
}

# ---------------------------------------------------------------------------
# Bildirim olmayan domain olaylari: SNS olay topic'i -> bu kuyruk -> scheduler worker.
#   MEMBERSHIP_ENDED  tasinmada gecis / araclarin gece taramasini beklemeden pasife alinmasi
# Liste apps/api/src/workers/scheduler-worker.ts SCHEDULER_EVENT_TYPES ile ayni olmali; bildirim
# kuyrugunun listesiyle (sns_sqs.tf) birlesimi EVENT_TYPES'a esittir (notification-filter.test.ts).
# Kuyruk politikasi yalnizca olay topic'ine izin verir; Scheduler rolunun kimlik politikasi aynen gecerli.
# ---------------------------------------------------------------------------

locals {
  scheduler_event_types = ["MEMBERSHIP_ENDED"]
}

data "aws_iam_policy_document" "jobs_queue" {
  statement {
    sid     = "AllowEventsTopic"
    actions = ["sqs:SendMessage"]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    resources = [aws_sqs_queue.jobs.arn]

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.events.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "jobs" {
  queue_url = aws_sqs_queue.jobs.id
  policy    = data.aws_iam_policy_document.jobs_queue.json
}

resource "aws_sns_topic_subscription" "jobs_events" {
  topic_arn            = aws_sns_topic.events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.jobs.arn
  raw_message_delivery = true

  filter_policy_scope = "MessageAttributes"
  filter_policy = jsonencode({
    eventType = local.scheduler_event_types
  })

  depends_on = [aws_sqs_queue_policy.jobs]
}

# ---------------------------------------------------------------------------
# Worker Lambda
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "scheduler_worker" {
  name              = "/aws/lambda/${local.scheduler_function}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "scheduler_worker" {
  name               = local.scheduler_function
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "scheduler_worker" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.scheduler_worker.arn}:*"]
  }

  # Defter yazimi API ile ayni kurallarla: DeleteItem / BatchWriteItem / Scan YOK.
  # Index: site dizini (GSI1) sorgusu.
  statement {
    sid = "DynamoDbTable"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [
      aws_dynamodb_table.main.arn,
      "${aws_dynamodb_table.main.arn}/index/*",
    ]
  }

  # Denetim gunlugu (audit.tf): zamanlanmis defter yazimlari denetlenir, gece zincir dogrulanir. Degistirme/silme acikca reddedilir.
  statement {
    sid       = "AuditAppendOnly"
    actions   = local.audit_app_actions
    resources = [aws_dynamodb_table.audit.arn, "${aws_dynamodb_table.audit.arn}/index/*"]
  }

  statement {
    sid       = "DenyAuditMutation"
    effect    = "Deny"
    actions   = local.audit_mutating_actions
    resources = [aws_dynamodb_table.audit.arn]
  }

  statement {
    sid       = "PublishDomainEvents"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.events.arn]
  }

  statement {
    sid = "ConsumeJobs"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.jobs.arn]
  }

  # Adim 2-2: ledger_audit tur mesaji site basina mesajlari ayni kuyruga birakir (fan-out).
  statement {
    sid       = "FanoutJobs"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.jobs.arn]
  }

  # push_receipts: Expo makbuz sorgusu icin erisim anahtari (push.tf).
  dynamic "statement" {
    for_each = local.push_enabled ? [1] : []
    content {
      sid       = "ReadExpoAccessToken"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [aws_secretsmanager_secret.expo_access_token[0].arn]
    }
  }

  # payment_reconcile: saglayicidan sonuc sorgulamak icin anahtar okuma.
  dynamic "statement" {
    for_each = local.payments_enabled ? [values(local.payments_secret_arns)] : []
    content {
      sid       = "ReadPaymentProviderSecret"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = statement.value
    }
  }
  # P4: transfer talimati aninda aktarim alicisini COZME (Encrypt yok); yalnizca payment-payee baglamiyla.
  dynamic "statement" {
    for_each = local.payments_enabled ? [local.payee_kms_key_arn] : []
    content {
      sid       = "DecryptPaymentPayee"
      actions   = ["kms:Decrypt"]
      resources = [statement.value]
      condition {
        test     = "StringEquals"
        variable = "kms:EncryptionContext:purpose"
        values   = ["payment-payee"]
      }
    }
  }
}

resource "aws_iam_role_policy" "scheduler_worker" {
  name   = "scheduler-worker"
  role   = aws_iam_role.scheduler_worker.id
  policy = data.aws_iam_policy_document.scheduler_worker.json
}

resource "aws_lambda_function" "scheduler_worker" {
  function_name    = local.scheduler_function
  description      = "Zamanlanmis gorevler: gecikme tazminati, aylik aidat, borc hatirlatma, odeme mutabakati"
  role             = aws_iam_role.scheduler_worker.arn
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  handler          = "scheduler-worker.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 512
  timeout          = local.scheduler_timeout_seconds

  environment {
    variables = merge({
      NODE_ENV             = "production"
      DYNAMODB_TABLE_NAME  = aws_dynamodb_table.main.name
      AUDIT_TABLE_NAME     = aws_dynamodb_table.audit.name
      EVENTS_MODE          = "sns"
      EVENTS_SNS_TOPIC_ARN = aws_sns_topic.events.arn
      # EMF metriklerinin `Stack` boyutu (operations.tf alarmlari ayni degeri bekler).
      METRICS_STACK                = local.name
      OUTBOX_SWEEP_MIN_AGE_SECONDS = tostring(local.outbox_sweep_min_age_seconds)
      # Buyuk sitelerde aylik aidat arka plan isi olarak (bulk_jobs.tf).
      BULK_JOBS_QUEUE_URL = aws_sqs_queue.bulk_jobs.url
      # Adim 2-2: ledger_audit site basina mesajlarla (fan-out) ayni kuyruga.
      SCHEDULED_JOBS_QUEUE_URL = aws_sqs_queue.jobs.url
    }, local.payments_env, local.push_env)
  }

  depends_on = [
    aws_cloudwatch_log_group.scheduler_worker,
    aws_iam_role_policy.scheduler_worker,
  ]

  lifecycle {
    precondition {
      condition     = local.jobs_visibility_timeout >= 6 * local.scheduler_timeout_seconds
      error_message = "Kuyruk gorunurluk zaman asimi worker zaman asiminin en az 6 kati olmali."
    }
  }
}

resource "aws_lambda_event_source_mapping" "jobs" {
  event_source_arn        = aws_sqs_queue.jobs.arn
  function_name           = aws_lambda_function.scheduler_worker.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  # Ayni anda en fazla 2 is: ay basinda gecikme tazminati ve aidat ayni anda yarismasin.
  scaling_config {
    maximum_concurrency = 2
  }

  depends_on = [aws_iam_role_policy.scheduler_worker]
}

# ---------------------------------------------------------------------------
# EventBridge Scheduler
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    # Karisik vekil (confused deputy) korumasi: yalnizca bu hesabin zamanlamalari.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler_send" {
  statement {
    sid       = "SendJobs"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.jobs.arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "send-scheduled-jobs"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler_send.json
}

resource "aws_scheduler_schedule_group" "main" {
  name = local.name
}

# Online odeme acikken payment_reconcile eklenir (payments.tf). outbox_sweep / ledger_audit:
# zamanlayici rolunun mevcut tablo/index ve sns:Publish yetkisi yeterlidir (ek IAM yok). Saat dilimi yalnizca cron
# ifadelerinde anlamlidir; rate() icin verilmez.
resource "aws_scheduler_schedule" "jobs" {
  for_each = merge(local.scheduled_jobs, local.payment_jobs, local.push_jobs)

  name                         = replace(each.key, "_", "-")
  group_name                   = aws_scheduler_schedule_group.main.name
  description                  = each.value.description
  schedule_expression          = each.value.cron
  schedule_expression_timezone = startswith(each.value.cron, "cron(") ? "Europe/Istanbul" : null
  state                        = var.scheduler_enabled ? "ENABLED" : "DISABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_sqs_queue.jobs.arn
    role_arn = aws_iam_role.scheduler.arn

    # Context attribute: Scheduler planlanan zamani ISO 8601 olarak yerlestirir.
    input = jsonencode({
      job           = each.key
      scheduledTime = "<aws.scheduler.scheduled-time>"
    })

    retry_policy {
      maximum_event_age_in_seconds = 86400
      maximum_retry_attempts       = 185
    }
  }

  depends_on = [aws_iam_role_policy.scheduler]
}

# ---------------------------------------------------------------------------
# Alarmlar
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "jobs_dlq" {
  alarm_name          = "${local.name}-scheduled-jobs-dlq-not-empty"
  alarm_description   = "Zamanlanmis gorev DLQ'sunda islenemeyen mesaj var (aidat/tazminat/hatirlatma eksik kalmis olabilir)."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.jobs_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "scheduler_worker_errors" {
  alarm_name          = "${local.scheduler_function}-errors"
  alarm_description   = "Zamanlanmis gorev worker'i hata veriyor."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.scheduler_worker.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
