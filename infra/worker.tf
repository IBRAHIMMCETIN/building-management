# ---------------------------------------------------------------------------
# Bildirim worker'i: notification SQS kuyrugu -> Lambda (event source mapping).
#
# Kod: apps/api/src/workers/notification-worker.ts (build:lambda -> notification-worker.mjs)
# - Kismi toplu hata bildirimi (ReportBatchItemFailures): yalnizca basarisiz mesajlar
#   yeniden denenir; 5 denemeden sonra DLQ'ya duser (sns_sqs.tf) ve alarm calar.
# - Es zamanli calisma 2 ile sinirli: SMS/WhatsApp saglayicilarinin hiz sinirlarini asmamak
#   ve DynamoDB'yi korumak icin.
# - Kuyruk gorunurluk zaman asimi (180 sn) = 6 x Lambda zaman asimi (30 sn): AWS onerisi.
# ---------------------------------------------------------------------------

locals {
  worker_function        = "${local.name}-notification-worker"
  worker_timeout_seconds = 30
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

  # Okuma: uyelikler ve daireler (alici cozumleme). Yazma: yalnizca NOTIF# isleme kaydi.
  statement {
    sid       = "DynamoDb"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.main.arn]
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
}

resource "aws_iam_role_policy" "notification_worker" {
  name   = "notification-worker"
  role   = aws_iam_role.notification_worker.id
  policy = data.aws_iam_policy_document.notification_worker.json
}

resource "aws_lambda_function" "notification_worker" {
  function_name    = local.worker_function
  description      = "SQS bildirim kuyrugu tuketicisi (DUE_GENERATED, PAYMENT_RECEIVED, ANNOUNCEMENT_PUBLISHED)"
  role             = aws_iam_role.notification_worker.arn
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  handler          = "notification-worker.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = local.worker_timeout_seconds

  environment {
    variables = {
      NODE_ENV            = "production"
      DYNAMODB_TABLE_NAME = aws_dynamodb_table.main.name
    }
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
