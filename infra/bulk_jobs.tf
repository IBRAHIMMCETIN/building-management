# ---------------------------------------------------------------------------
# Arka plan toplu isleri: buyuk toplu aidat tahakkuku ve sayac donemi onayi.
#
# Kod: apps/api/src/modules/bulkjobs (is kaydi, kira, continuation) +
#      apps/api/src/workers/bulk-worker.ts (build:lambda -> bulk-worker.mjs)
#
# Akis: API (POST /api/finance/dues/jobs, buyuk /dues ve /metering/.../approve) is kaydini
# DynamoDB'ye yazar ve bu kuyruga mesaj birakir -> 202. Worker isi kiralar, bolumleri parca
# parca yazar; Lambda suresi azalinca AYNI kuyruga devam mesaji birakir. Zamanlanmis aylik aidat
# (scheduler-worker) da buyuk sitelerde bu kuyrugu kullanir.
#
# Neden ayri kuyruk: `scheduled-jobs` tuketicisi en fazla 2 eszamanli calisir ve gece/ay basi
# islerine ayrilmistir; kullanicinin baslattigi uzun toplu isler o isleri geciktirmemeli.
# Ayni zip paketi (api.tf `archive_file.lambda`) kullanilir.
# ---------------------------------------------------------------------------

locals {
  bulk_worker_function        = "${local.name}-bulk-worker"
  bulk_worker_timeout_seconds = 300
  # Lambda zaman asimi x 6 (AWS onerisi). Is kirasi (360 sn) bundan kisadir.
  bulk_jobs_visibility_timeout = 6 * 300
}

resource "aws_sqs_queue" "bulk_jobs_dlq" {
  name                      = "${local.name}-bulk-jobs-dlq"
  message_retention_seconds = 1209600 # 14 gun
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "bulk_jobs" {
  name                       = "${local.name}-bulk-jobs"
  visibility_timeout_seconds = local.bulk_jobs_visibility_timeout
  message_retention_seconds  = 345600 # 4 gun
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true

  # Gecici hata 5 kez tekrar denenir (ilerleme is kaydinda; tekrar kaldigi yerden devam eder).
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.bulk_jobs_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "bulk_jobs_dlq" {
  queue_url = aws_sqs_queue.bulk_jobs_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.bulk_jobs.arn]
  })
}

# ---------------------------------------------------------------------------
# Worker Lambda
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "bulk_worker" {
  name              = "/aws/lambda/${local.bulk_worker_function}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "bulk_worker" {
  name               = local.bulk_worker_function
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "bulk_worker" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.bulk_worker.arn}:*"]
  }

  # Defter yazimi API ile ayni kurallarla: DeleteItem / BatchWriteItem / Scan YOK.
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

  # Defter ve sayac yazimlari denetim kaydini ayni atomik islemde ekler.
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
    sid = "ConsumeBulkJobs"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.bulk_jobs.arn]
  }

  # Continuation: is bitmediyse ayni kuyruga devam mesaji.
  statement {
    sid       = "ContinueBulkJobs"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.bulk_jobs.arn]
  }
}

resource "aws_iam_role_policy" "bulk_worker" {
  name   = "bulk-worker"
  role   = aws_iam_role.bulk_worker.id
  policy = data.aws_iam_policy_document.bulk_worker.json
}

resource "aws_lambda_function" "bulk_worker" {
  function_name    = local.bulk_worker_function
  description      = "Arka plan toplu isleri: buyuk toplu aidat tahakkuku ve sayac donemi onayi (parcali, continuation)"
  role             = aws_iam_role.bulk_worker.arn
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  handler          = "bulk-worker.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 1024
  timeout          = local.bulk_worker_timeout_seconds

  environment {
    variables = {
      NODE_ENV            = "production"
      DYNAMODB_TABLE_NAME = aws_dynamodb_table.main.name
      AUDIT_TABLE_NAME    = aws_dynamodb_table.audit.name
      BULK_JOBS_QUEUE_URL = aws_sqs_queue.bulk_jobs.url
      # Alt parca (ilerleme kaydi) ve parca ici eszamanlilik (sicak gelir hesabi cakismalari
      # depoda kisa beklemeyle tekrar denenir).
      BULK_JOB_BATCH_SIZE  = "25"
      BULK_JOB_CONCURRENCY = "4"
      METRICS_STACK        = local.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.bulk_worker,
    aws_iam_role_policy.bulk_worker,
  ]

  lifecycle {
    precondition {
      condition     = local.bulk_jobs_visibility_timeout >= 6 * local.bulk_worker_timeout_seconds
      error_message = "Kuyruk gorunurluk zaman asimi worker zaman asiminin en az 6 kati olmali."
    }
  }
}

resource "aws_lambda_event_source_mapping" "bulk_jobs" {
  event_source_arn        = aws_sqs_queue.bulk_jobs.arn
  function_name           = aws_lambda_function.bulk_worker.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  # Farkli apartmanlarin isleri paralel; ayni isin iki kopyasi kira ile engellenir.
  scaling_config {
    maximum_concurrency = 5
  }

  depends_on = [aws_iam_role_policy.bulk_worker]
}

# ---------------------------------------------------------------------------
# Ureticiler: API ve zamanlayici worker'i bu kuyruga yazar
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "bulk_jobs_send" {
  statement {
    sid       = "SendBulkJobs"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.bulk_jobs.arn]
  }
}

resource "aws_iam_role_policy" "api_bulk_jobs" {
  name   = "send-bulk-jobs"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.bulk_jobs_send.json
}

resource "aws_iam_role_policy" "scheduler_worker_bulk_jobs" {
  name   = "send-bulk-jobs"
  role   = aws_iam_role.scheduler_worker.id
  policy = data.aws_iam_policy_document.bulk_jobs_send.json
}

# ---------------------------------------------------------------------------
# Alarmlar
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "bulk_jobs_dlq" {
  alarm_name          = "${local.name}-bulk-jobs-dlq-not-empty"
  alarm_description   = "Toplu is DLQ'sunda islenemeyen mesaj var: bir toplu tahakkuk / sayac onayi yarida kalmis olabilir. Is kaydi (GET /api/jobs/:jobId) ve bulk-worker loglarini (msg=bulk_job_message_failed) kontrol edin; yonetici 'Tekrar dene' ile kaldigi yerden devam ettirebilir."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.bulk_jobs_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "bulk_jobs_age" {
  alarm_name          = "${local.name}-bulk-jobs-stuck"
  alarm_description   = "Toplu is kuyrugunda 15 dakikadan eski mesaj var (worker calismiyor veya kisitlaniyor)."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.bulk_jobs.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 900
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "bulk_worker_errors" {
  alarm_name          = "${local.bulk_worker_function}-errors"
  alarm_description   = "Toplu is worker'i hata veriyor (zaman asimi dahil)."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.bulk_worker.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
