# ---------------------------------------------------------------------------
# Transactional outbox relay: DynamoDB Streams -> outbox-relay Lambda -> SNS olay topic'i.
#
# Kod: apps/api/src/workers/outbox-relay.ts (build:lambda -> outbox-relay.mjs)
# - API ve zamanlayici olaylari defter yazimiyla AYNI TransactWriteItems icinde
#   `OUTBOX#<eventId>` kaydi olarak yazar; bu Lambda yalnizca o kayitlarin INSERT'lerini alir
#   (event source mapping filtresi) ve SNS'e yayinlar, sonra kaydi `published` isaretler.
# - Kismi hata (ReportBatchItemFailures): ilk basarisiz kayittan itibaren yeniden denenir; zehirli
#   kayit `bisect` ile ayrilir. Tekrar denemeler/kayit yasi tukenirse kayit bilgisi DLQ'ya duser
#   ve alarm calar. Outbox kaydi `pending` kaldigi icin suprucu (`outbox_sweep`) yeniden yayinlar.
# - En az yetki: stream okuma yalnizca bu tablonun stream'leri, yazma yalnizca UpdateItem
#   (durum isaretleme), yayin yalnizca olay topic'i, DLQ'ya yalnizca SendMessage.
# ---------------------------------------------------------------------------

# Akis filtresi: yalnizca outbox kayitlarinin INSERT'leri (relay'in kendi MODIFY'lari ve TTL
# silmeleri dahil diger her sey elenir; elenen kayitlar Lambda cagirmaz).
locals {
  outbox_relay_function        = "${local.name}-outbox-relay"
  outbox_relay_timeout_seconds = 30
  outbox_stream_filter = jsonencode({
    eventName = ["INSERT"]
    dynamodb = {
      Keys = {
        SK = { S = [{ prefix = "OUTBOX#" }] }
      }
    }
  })
}

resource "aws_cloudwatch_log_group" "outbox_relay" {
  name              = "/aws/lambda/${local.outbox_relay_function}"
  retention_in_days = var.log_retention_days
}

# Tekrar denemeleri tukenen parcalarin kaydi (stream konumu; olay govdesi degil).
resource "aws_sqs_queue" "outbox_relay_dlq" {
  name                      = "${local.name}-outbox-relay-dlq"
  message_retention_seconds = 1209600 # 14 gun
  sqs_managed_sse_enabled   = true
}

resource "aws_iam_role" "outbox_relay" {
  name               = local.outbox_relay_function
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "outbox_relay" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.outbox_relay.arn}:*"]
  }

  # Event source mapping, fonksiyon rolunun yetkisiyle akisi okur. Yalnizca bu tablonun
  # stream'leri (stream yeniden olusturulsa da gecerli).
  statement {
    sid = "ReadTableStream"
    actions = [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
      "dynamodb:ListStreams",
    ]
    resources = ["${aws_dynamodb_table.main.arn}/stream/*"]
  }

  # Yalnizca outbox durum isaretleme (Put/Delete/Query/Scan YOK).
  statement {
    sid       = "MarkOutboxPublished"
    actions   = ["dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.main.arn]
  }

  statement {
    sid       = "PublishDomainEvents"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.events.arn]
  }

  # Stream event source mapping'in hata hedefi (on-failure destination).
  statement {
    sid       = "OnFailureDestination"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.outbox_relay_dlq.arn]
  }
}

resource "aws_iam_role_policy" "outbox_relay" {
  name   = "outbox-relay"
  role   = aws_iam_role.outbox_relay.id
  policy = data.aws_iam_policy_document.outbox_relay.json
}

resource "aws_lambda_function" "outbox_relay" {
  function_name    = local.outbox_relay_function
  description      = "Transactional outbox relay: DynamoDB Streams -> SNS olay topic'i"
  role             = aws_iam_role.outbox_relay.arn
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  handler          = "outbox-relay.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = local.outbox_relay_timeout_seconds

  environment {
    variables = {
      NODE_ENV             = "production"
      DYNAMODB_TABLE_NAME  = aws_dynamodb_table.main.name
      EVENTS_MODE          = "sns"
      EVENTS_SNS_TOPIC_ARN = aws_sns_topic.events.arn
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.outbox_relay,
    aws_iam_role_policy.outbox_relay,
  ]
}

# Bir saatten eski kayit icin relay'den vazgecilir (DLQ + alarm); outbox kaydi `pending` kaldigi
# icin suprucu yayinlar. Stream saklama suresi 24 saattir.
resource "aws_lambda_event_source_mapping" "outbox" {
  event_source_arn                   = aws_dynamodb_table.main.stream_arn
  function_name                      = aws_lambda_function.outbox_relay.arn
  starting_position                  = "LATEST"
  batch_size                         = 25
  maximum_batching_window_in_seconds = 1
  parallelization_factor             = 1
  function_response_types            = ["ReportBatchItemFailures"]
  bisect_batch_on_function_error     = true
  maximum_retry_attempts             = 10
  maximum_record_age_in_seconds      = 3600

  filter_criteria {
    filter {
      pattern = local.outbox_stream_filter
    }
  }

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.outbox_relay_dlq.arn
    }
  }

  # Rol politikasi yazilmadan eslestirme olusturulursa stream erisimi reddedilir.
  depends_on = [aws_iam_role_policy.outbox_relay]
}

resource "aws_cloudwatch_metric_alarm" "outbox_relay_errors" {
  alarm_name          = "${local.outbox_relay_function}-errors"
  alarm_description   = "Outbox relay hata veriyor (5 dakikada 5+ hata)."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.outbox_relay.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Akis gerisinde kaliyorsa (relay durmus / yavas): olaylar gecikiyor.
resource "aws_cloudwatch_metric_alarm" "outbox_relay_iterator_age" {
  alarm_name          = "${local.outbox_relay_function}-iterator-age"
  alarm_description   = "Outbox relay akisin 5 dakikadan fazla gerisinde."
  namespace           = "AWS/Lambda"
  metric_name         = "IteratorAge"
  dimensions          = { FunctionName = aws_lambda_function.outbox_relay.function_name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 300000 # ms
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "outbox_relay_dlq" {
  alarm_name          = "${local.name}-outbox-relay-dlq-not-empty"
  alarm_description   = "Outbox relay tekrar denemeleri tukendi; olaylar suprucuye kaldi."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.outbox_relay_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
