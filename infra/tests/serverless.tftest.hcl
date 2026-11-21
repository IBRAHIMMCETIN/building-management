# AWS kimlik bilgisi gerektirmeyen plan testleri (sahte saglayicilar):
#   terraform -chdir=infra init -backend=false && terraform -chdir=infra test

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = { region = "eu-central-1" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  # Saglayicinin ARN dogrulamalarindan gecen sahte degerler.
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:eu-central-1:123456789012:mock-topic" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:eu-central-1:123456789012:mock-queue"
      id  = "https://sqs.eu-central-1.amazonaws.com/123456789012/mock-queue"
      url = "https://sqs.eu-central-1.amazonaws.com/123456789012/mock-queue"
    }
  }
  mock_resource "aws_dynamodb_table" {
    defaults = {
      arn        = "arn:aws:dynamodb:eu-central-1:123456789012:table/mock"
      stream_arn = "arn:aws:dynamodb:eu-central-1:123456789012:table/mock/stream/2026-11-21T00:00:00.000"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-central-1:123456789012:log-group:mock" }
  }
  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:eu-central-1:123456789012:function:mock"
      invoke_arn = "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-central-1:123456789012:function:mock/invocations"
    }
  }
  mock_resource "aws_cognito_user_pool" {
    defaults = {
      id       = "eu-central-1_mock"
      arn      = "arn:aws:cognito-idp:eu-central-1:123456789012:userpool/eu-central-1_mock"
      endpoint = "cognito-idp.eu-central-1.amazonaws.com/eu-central-1_mock"
    }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      execution_arn = "arn:aws:execute-api:eu-central-1:123456789012:mockapi"
      api_endpoint  = "https://mockapi.execute-api.eu-central-1.amazonaws.com"
    }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:mock-AbCdEf" }
  }
  # Gecerli JSON uretmesi gereken politika belgeleri.
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

mock_provider "archive" {
  mock_data "archive_file" {
    defaults = { output_base64sha256 = "dGVzdA==" }
  }
}

variables {
  environment     = "prod"
  lambda_dist_dir = "tests"
  app_version     = "test-sha"
}

run "prod_plan" {
  command = plan

  # Mock saglayicinin hesaplanan degerleri varsayilan olarak yalnizca apply'da uretilir;
  # plan'da `known after apply` kalan kuyruk ARN'i asagidaki baglanti assert'ini kirar.
  # ARN'i plan asamasinda sabitliyoruz (Terraform >= 1.11 `override_during`).
  override_resource {
    target          = aws_sqs_queue.notification
    override_during = plan
    values = {
      arn = "arn:aws:sqs:eu-central-1:123456789012:building-management-prod-notifications"
      id  = "https://sqs.eu-central-1.amazonaws.com/123456789012/building-management-prod-notifications"
      url = "https://sqs.eu-central-1.amazonaws.com/123456789012/building-management-prod-notifications"
    }
  }
  # Outbox relay baglantisi: tablo ve stream ARN'leri plan asamasinda sabitlenir.
  override_resource {
    target          = aws_dynamodb_table.main
    override_during = plan
    values = {
      arn        = "arn:aws:dynamodb:eu-central-1:123456789012:table/building-management"
      stream_arn = "arn:aws:dynamodb:eu-central-1:123456789012:table/building-management/stream/2026-11-21T00:00:00.000"
    }
  }

  # --- DynamoDB ---
  assert {
    condition     = aws_dynamodb_table.main.name == "building-management"
    error_message = "prod tablo adi building-management olmali"
  }
  assert {
    condition     = aws_dynamodb_table.main.point_in_time_recovery[0].enabled
    error_message = "PITR acik olmali"
  }
  assert {
    condition     = aws_dynamodb_table.main.ttl[0].enabled && aws_dynamodb_table.main.ttl[0].attribute_name == "ttl"
    error_message = "TTL `ttl` alaninda acik olmali"
  }
  assert {
    condition = anytrue([
      for g in aws_dynamodb_table.main.global_secondary_index :
      g.name == "GSI1" && g.projection_type == "ALL" &&
      toset([for k in g.key_schema : "${k.key_type}:${k.attribute_name}"]) == toset(["HASH:GSI1PK", "RANGE:GSI1SK"])
    ])
    error_message = "GSI1 (GSI1PK/GSI1SK, ALL) tanimli olmali"
  }
  assert {
    condition     = aws_dynamodb_table.main.deletion_protection_enabled
    error_message = "Silme korumasi varsayilan acik olmali"
  }

  # --- Cognito ---
  assert {
    condition     = aws_cognito_user_pool.main.user_pool_tier == "LITE"
    error_message = "Varsayilan katman maliyet icin LITE olmali"
  }
  assert {
    condition     = aws_cognito_user_pool.main.lambda_config[0].pre_token_generation_config[0].lambda_version == "V1_0"
    error_message = "LITE katmaninda Pre Token Generation V1 kullanilmali"
  }
  assert {
    condition     = output.api_token_use == "id" && output.frontend_env.VITE_COGNITO_TOKEN_USE == "id"
    error_message = "LITE katmaninda istemci ID token gondermeli"
  }
  assert {
    condition     = aws_cognito_user_pool.main.email_configuration[0].email_sending_account == "COGNITO_DEFAULT" && length(aws_ses_identity_policy.cognito) == 0
    error_message = "SES verilmezse COGNITO_DEFAULT kullanilmali"
  }
  assert {
    condition     = !aws_cognito_user_pool_client.web.generate_secret
    error_message = "SPA istemcisi gizli anahtar tasimamali"
  }
  assert {
    condition     = contains(aws_cognito_user_pool_client.web.write_attributes, "custom:active_apartment")
    error_message = "Kullanici aktif apartman tercihini yazabilmeli"
  }
  assert {
    condition     = aws_cognito_user_pool_client.web.access_token_validity == 15
    error_message = "Access token omru kisa olmali"
  }

  # --- SNS / SQS ---
  assert {
    condition = jsondecode(aws_sns_topic_subscription.notification.filter_policy).eventType == [
      "DUE_GENERATED", "PAYMENT_RECEIVED", "ANNOUNCEMENT_PUBLISHED", "LATE_FEE_POSTED", "DUES_REMINDER", "DUES_BATCH_SUMMARY",
    ]
    error_message = "Bildirim kuyrugu alti olay turune abone olmali (zamanlanmis gorev olaylari ve toplu tahakkuk ozeti dahil)"
  }
  assert {
    condition     = aws_sns_topic_subscription.notification.raw_message_delivery
    error_message = "Raw delivery acik olmali (govde = olay JSON)"
  }
  assert {
    condition     = aws_sqs_queue.notification.sqs_managed_sse_enabled && aws_sqs_queue.notification_dlq.sqs_managed_sse_enabled
    error_message = "Kuyruklar SSE-SQS ile sifrelenmeli"
  }
  assert {
    condition     = length(aws_sns_topic_subscription.alerts_email) == 0
    error_message = "alert_email bos iken e-posta aboneligi olusmamali"
  }

  # --- Lambda / API ---
  assert {
    condition     = tolist(aws_lambda_function.api.architectures) == tolist(["arm64"]) && aws_lambda_function.api.runtime == "nodejs24.x"
    error_message = "API Lambda arm64 + nodejs24.x olmali"
  }
  assert {
    condition     = aws_lambda_function.api.handler == "api.handler" && aws_lambda_function.pre_token.handler == "pre-token.handler"
    error_message = "Handler adlari build:lambda ciktisiyla eslesmeli"
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.AUTH_MODE == "apigw"
    error_message = "Lambda AUTH_MODE=apigw ile calismali"
  }
  # Olaylar outbox'tan yayinlanir: API Lambda'si olay yayinlamaz.
  assert {
    condition     = !contains(keys(aws_lambda_function.api.environment[0].variables), "EVENTS_MODE") && !contains(keys(aws_lambda_function.api.environment[0].variables), "EVENTS_SNS_TOPIC_ARN")
    error_message = "API Lambda'sinda EVENTS_* degiskenleri olmamali (olaylar outbox-relay'den yayinlanir)"
  }
  assert {
    condition     = length([for a in flatten([for st in data.aws_iam_policy_document.api.statement : st.actions]) : a if startswith(a, "sns:")]) == 0
    error_message = "API Lambda'sinin sns yetkisi olmamali"
  }

  assert {
    condition     = toset([for a in flatten([for st in data.aws_iam_policy_document.api.statement : st.actions]) : a if startswith(a, "cognito-idp:")]) == toset(["cognito-idp:AdminGetUser", "cognito-idp:AdminCreateUser"])
    error_message = "API Lambda yalnizca davet icin AdminGetUser/AdminCreateUser yetkisine sahip olmali"
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.APP_VERSION == "test-sha"
    error_message = "APP_VERSION degiskenden gelmeli"
  }
  assert {
    condition     = aws_lambda_function.pre_token.timeout <= 5
    error_message = "Cognito tetikleyicisi 5 sn icinde yanit vermeli"
  }
  assert {
    condition     = aws_apigatewayv2_route.api.authorization_type == "JWT" && aws_apigatewayv2_route.api.route_key == "ANY /api/{proxy+}"
    error_message = "API rotalari JWT ile korunmali"
  }
  assert {
    condition     = aws_apigatewayv2_route.health.route_key == "GET /api/health" && aws_apigatewayv2_route.health.authorization_type == "NONE"
    error_message = "Yalnizca saglik kontrolu acik olmali"
  }
  assert {
    condition     = aws_apigatewayv2_route.cors_preflight.route_key == "OPTIONS /api/{proxy+}" && aws_apigatewayv2_route.cors_preflight.authorization_type == "NONE"
    error_message = "CORS preflight (OPTIONS) kimliksiz olmali; aksi halde tarayici istekleri 401 ile engellenir"
  }
  assert {
    condition     = aws_apigatewayv2_integration.api.payload_format_version == "2.0"
    error_message = "Hono aws-lambda adaptoru payload v2 bekler"
  }

  # --- Bildirim worker'i ---
  assert {
    condition     = aws_lambda_function.notification_worker.handler == "notification-worker.handler" && tolist(aws_lambda_function.notification_worker.architectures) == tolist(["arm64"])
    error_message = "Worker handler/mimari hatali"
  }
  assert {
    condition     = aws_lambda_event_source_mapping.notification.event_source_arn == aws_sqs_queue.notification.arn && aws_sqs_queue.notification.arn == "arn:aws:sqs:eu-central-1:123456789012:building-management-prod-notifications"
    error_message = "Worker bildirim kuyruguna bagli olmali"
  }
  assert {
    condition     = contains(aws_lambda_event_source_mapping.notification.function_response_types, "ReportBatchItemFailures")
    error_message = "Kismi toplu hata bildirimi acik olmali"
  }
  assert {
    condition     = aws_sqs_queue.notification.visibility_timeout_seconds >= 6 * aws_lambda_function.notification_worker.timeout
    error_message = "Gorunurluk zaman asimi worker zaman asiminin 6 kati olmali"
  }

  # --- Bildirim e-postasi (Asama 4): varsayilan log, SES yetkisi yok ---
  assert {
    condition = (
      aws_lambda_function.notification_worker.environment[0].variables.NOTIFICATION_CHANNEL == "log" &&
      aws_lambda_function.notification_worker.environment[0].variables.SES_FROM_ADDRESS == "YÖNESİST <bildirim@yonetimsistemim.com>" &&
      !contains(keys(aws_lambda_function.notification_worker.environment[0].variables), "SES_CONFIGURATION_SET")
    )
    error_message = "Varsayilan bildirim kanali log, gonderen YÖNESİST adresi olmali"
  }
  assert {
    condition     = length([for a in flatten([for st in data.aws_iam_policy_document.notification_worker.statement : st.actions]) : a if startswith(a, "ses:")]) == 0
    error_message = "log kanalinda worker'a SES yetkisi verilmemeli"
  }
  assert {
    condition     = contains(jsondecode(aws_sns_topic_subscription.notification.filter_policy).eventType, "DUES_BATCH_SUMMARY")
    error_message = "Toplu tahakkuk ozet olayi bildirim kuyruguna ulasmali"
  }

  # --- Zamanlanmis gorevler ---
  assert {
    condition = (
      aws_scheduler_schedule.jobs["late_fees"].schedule_expression == "cron(30 2 1 * ? *)" &&
      aws_scheduler_schedule.jobs["monthly_dues"].schedule_expression == "cron(0 3 1 * ? *)" &&
      aws_scheduler_schedule.jobs["dues_reminders"].schedule_expression == "cron(0 10 * * ? *)"
    )
    error_message = "Zamanlama ifadeleri hatali (tazminat 02:30, aidat 03:00, hatirlatma 10:00)"
  }
  assert {
    condition     = alltrue([for s in aws_scheduler_schedule.jobs : (startswith(s.schedule_expression, "cron(") ? s.schedule_expression_timezone == "Europe/Istanbul" : s.schedule_expression_timezone == null) && s.state == "ENABLED"])
    error_message = "cron zamanlamalari Europe/Istanbul, rate() zamanlamalari saat dilimsiz ve varsayilan acik olmali"
  }

  # --- Outbox suprucusu ve defter denetimi (Asama 3) ---
  assert {
    condition = (
      aws_scheduler_schedule.jobs["outbox_sweep"].schedule_expression == "rate(5 minutes)" &&
      aws_scheduler_schedule.jobs["outbox_sweep"].schedule_expression_timezone == null &&
      jsondecode(aws_scheduler_schedule.jobs["outbox_sweep"].target[0].input).job == "outbox_sweep"
    )
    error_message = "outbox_sweep 5 dakikada bir calismali"
  }
  assert {
    condition = (
      aws_scheduler_schedule.jobs["ledger_audit"].schedule_expression == "cron(40 3 * * ? *)" &&
      aws_scheduler_schedule.jobs["ledger_audit"].schedule_expression_timezone == "Europe/Istanbul" &&
      jsondecode(aws_scheduler_schedule.jobs["ledger_audit"].target[0].input).job == "ledger_audit"
    )
    error_message = "ledger_audit her gece 03:40 (Istanbul) calismali"
  }
  assert {
    condition = (
      aws_lambda_function.scheduler_worker.environment[0].variables.METRICS_STACK == "building-management" &&
      aws_lambda_function.scheduler_worker.environment[0].variables.OUTBOX_SWEEP_MIN_AGE_SECONDS == "120"
    )
    error_message = "Scheduler worker metrik boyutu yigin adi, suprucu esigi 120 sn olmali"
  }
  assert {
    condition = alltrue([
      for a in [aws_cloudwatch_metric_alarm.ledger_drift, aws_cloudwatch_metric_alarm.outbox_sweep_failed, aws_cloudwatch_metric_alarm.outbox_stuck] :
      a.namespace == "BuildingManagement" && length(a.dimensions) == 1 && a.dimensions["Stack"] == "building-management" && a.treat_missing_data == "notBreaching"
    ])
    error_message = "Operasyon alarmlari worker'in EMF namespace ve Stack boyutunu dinlemeli"
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.ledger_drift.metric_name == "LedgerDrift" &&
      aws_cloudwatch_metric_alarm.ledger_drift.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.ledger_drift.threshold == 0 &&
      aws_cloudwatch_metric_alarm.ledger_drift.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.outbox_sweep_failed.metric_name == "OutboxSweepFailed" &&
      aws_cloudwatch_metric_alarm.outbox_stuck.metric_name == "OutboxOldestPendingSeconds" &&
      aws_cloudwatch_metric_alarm.outbox_stuck.threshold == 900
    )
    error_message = "Defter sapmasi ilk bulguda, outbox takilmasi 15 dakikada alarm uretmeli"
  }
  assert {
    condition = length([
      for st in data.aws_iam_policy_document.scheduler_worker.statement : st
      if anytrue([for a in st.actions : startswith(a, "cloudwatch:")])
    ]) == 0
    error_message = "Metrikler EMF log satiriyla yazilir; scheduler worker'a cloudwatch yetkisi verilmemeli"
  }
  assert {
    condition     = alltrue([for k, s in aws_scheduler_schedule.jobs : jsondecode(s.target[0].input).job == k && jsondecode(s.target[0].input).scheduledTime == "<aws.scheduler.scheduled-time>"])
    error_message = "Hedef girdisi is adini ve planlanan zamani tasimali"
  }
  assert {
    condition     = aws_lambda_function.scheduler_worker.handler == "scheduler-worker.handler" && aws_lambda_function.scheduler_worker.environment[0].variables.EVENTS_MODE == "sns"
    error_message = "Scheduler worker handler/olay yayini hatali"
  }
  assert {
    condition     = aws_lambda_event_source_mapping.jobs.batch_size == 1 && contains(aws_lambda_event_source_mapping.jobs.function_response_types, "ReportBatchItemFailures")
    error_message = "Gorev kuyrugu tek tek ve kismi hata bildirimiyle islenmeli"
  }
  assert {
    condition     = aws_sqs_queue.jobs.visibility_timeout_seconds >= 6 * aws_lambda_function.scheduler_worker.timeout
    error_message = "Gorev kuyrugu gorunurluk zaman asimi worker zaman asiminin 6 kati olmali"
  }
  assert {
    condition = alltrue([
      for st in data.aws_iam_policy_document.scheduler_worker.statement :
      length(setintersection(toset(st.actions), toset(["dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:BatchWriteItem"]))) == 0
    ])
    error_message = "Scheduler worker defteri silemez/tarayamaz (append-only)"
  }
  assert {
    condition     = toset(flatten([for st in data.aws_iam_policy_document.scheduler_send.statement : st.actions])) == toset(["sqs:SendMessage"])
    error_message = "Scheduler rolu yalnizca gorev kuyruguna mesaj birakabilmeli"
  }

  # --- Transactional outbox relay ---
  assert {
    condition     = aws_dynamodb_table.main.stream_enabled && aws_dynamodb_table.main.stream_view_type == "NEW_IMAGE"
    error_message = "Tablo akisi NEW_IMAGE ile acik olmali"
  }
  assert {
    condition     = aws_lambda_function.outbox_relay.handler == "outbox-relay.handler" && tolist(aws_lambda_function.outbox_relay.architectures) == tolist(["arm64"])
    error_message = "Relay handler/mimari hatali"
  }
  assert {
    condition     = aws_lambda_function.outbox_relay.environment[0].variables.EVENTS_MODE == "sns"
    error_message = "Relay olaylari SNS'e yayinlamali"
  }
  assert {
    condition     = aws_lambda_event_source_mapping.outbox.event_source_arn == aws_dynamodb_table.main.stream_arn && aws_dynamodb_table.main.stream_arn == "arn:aws:dynamodb:eu-central-1:123456789012:table/building-management/stream/2026-11-21T00:00:00.000"
    error_message = "Relay tablo akisina bagli olmali"
  }
  assert {
    condition = (
      contains(aws_lambda_event_source_mapping.outbox.function_response_types, "ReportBatchItemFailures") &&
      aws_lambda_event_source_mapping.outbox.bisect_batch_on_function_error &&
      aws_lambda_event_source_mapping.outbox.starting_position == "LATEST" &&
      aws_lambda_event_source_mapping.outbox.maximum_retry_attempts > 0 &&
      length(aws_lambda_event_source_mapping.outbox.destination_config) == 1
    )
    error_message = "Relay kismi hata bildirimi, bisect, tekrar deneme ve DLQ hedefiyle calismali"
  }
  assert {
    condition = (
      jsondecode(one(aws_lambda_event_source_mapping.outbox.filter_criteria[0].filter).pattern).eventName == ["INSERT"] &&
      jsondecode(one(aws_lambda_event_source_mapping.outbox.filter_criteria[0].filter).pattern).dynamodb.Keys.SK.S[0].prefix == "OUTBOX#"
    )
    error_message = "Akis filtresi yalnizca OUTBOX# INSERT kayitlarini gecirmeli"
  }
  assert {
    condition = toset(flatten([for st in data.aws_iam_policy_document.outbox_relay.statement : st.actions])) == toset([
      "logs:CreateLogStream", "logs:PutLogEvents",
      "dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams",
      "dynamodb:UpdateItem", "sns:Publish", "sqs:SendMessage",
    ])
    error_message = "Relay rolu en az yetkili olmali (Put/Delete/Query/Scan yok)"
  }
  assert {
    condition     = one([for st in data.aws_iam_policy_document.outbox_relay.statement : st.resources if st.sid == "ReadTableStream"]) == toset(["arn:aws:dynamodb:eu-central-1:123456789012:table/building-management/stream/*"])
    error_message = "Stream okuma yalnizca bu tablonun akislarina sinirli olmali"
  }
}

run "documents_bucket" {
  command = plan

  variables {
    environment                  = "dev"
    dynamodb_deletion_protection = false
  }

  assert {
    condition     = aws_s3_bucket.documents.bucket == "building-management-dev-documents-123456789012-eu-central-1" && aws_s3_bucket.documents.force_destroy
    error_message = "Belge bucket adi/ortam ayari hatali"
  }
  assert {
    condition = (
      aws_s3_bucket_public_access_block.documents.block_public_acls &&
      aws_s3_bucket_public_access_block.documents.block_public_policy &&
      aws_s3_bucket_public_access_block.documents.ignore_public_acls &&
      aws_s3_bucket_public_access_block.documents.restrict_public_buckets
    )
    error_message = "Belge bucket'i tamamen private olmali"
  }
  assert {
    condition     = one(aws_s3_bucket_ownership_controls.documents.rule).object_ownership == "BucketOwnerEnforced"
    error_message = "ACL'ler kapali olmali"
  }
  assert {
    condition     = one(aws_s3_bucket_versioning.documents.versioning_configuration).status == "Enabled"
    error_message = "Surumleme acik olmali"
  }
  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.documents.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "Sunucu tarafi sifreleme acik olmali"
  }
  assert {
    condition = anytrue([
      for r in aws_s3_bucket_lifecycle_configuration.documents.rule :
      r.id == "pending-uploads" && one(r.filter).prefix == "tmp/" && one(r.expiration).days == 1
    ])
    error_message = "Gidere baglanmamis gecici yuklemeler 1 gunde silinmeli"
  }
  assert {
    condition = alltrue([
      for st in data.aws_iam_policy_document.api.statement :
      length(setintersection(toset(st.actions), toset(["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:*", "s3:PutBucketPolicy"]))) == 0
    ])
    error_message = "API belge silemez / bucket ayari degistiremez"
  }
  assert {
    condition     = one([for st in data.aws_iam_policy_document.documents_bucket.statement : st if st.sid == "DenyInsecureTransport"]).effect == "Deny"
    error_message = "Sifresiz (HTTP) erisim reddedilmeli"
  }
}

run "prod_keeps_documents" {
  command = plan

  assert {
    condition     = aws_s3_bucket.documents.bucket == "building-management-documents-123456789012-eu-central-1" && !aws_s3_bucket.documents.force_destroy
    error_message = "Prod belge bucket'i bos degilken silinememeli"
  }
}

run "scheduler_can_be_disabled" {
  command = plan

  variables {
    scheduler_enabled = false
  }

  assert {
    condition     = alltrue([for s in aws_scheduler_schedule.jobs : s.state == "DISABLED"])
    error_message = "scheduler_enabled=false iken zamanlamalar kapali olmali"
  }
}

run "staging_names_and_alerts" {
  command = plan

  variables {
    environment                  = "staging"
    alert_email                  = "ops@example.com"
    dynamodb_deletion_protection = false
  }

  assert {
    condition     = aws_dynamodb_table.main.name == "building-management-staging"
    error_message = "staging kaynaklari sonek almali"
  }
  assert {
    condition     = aws_cognito_user_pool.main.deletion_protection == "INACTIVE"
    error_message = "staging havuzu silinebilir olmali"
  }
  assert {
    condition     = length(aws_sns_topic_subscription.alerts_email) == 1
    error_message = "alert_email verilince e-posta aboneligi olusmali"
  }
}

run "rejects_plus_tier" {
  command = plan

  variables {
    cognito_user_pool_tier = "PLUS"
  }

  expect_failures = [var.cognito_user_pool_tier]
}

run "essentials_uses_v2_and_ses" {
  command = plan

  variables {
    cognito_user_pool_tier = "ESSENTIALS"
    ses_identity_arn       = "arn:aws:ses:eu-central-1:123456789012:identity/ornek.com"
    ses_from_address       = "Bina Yonetim <no-reply@ornek.com>"
  }

  assert {
    condition     = aws_cognito_user_pool.main.lambda_config[0].pre_token_generation_config[0].lambda_version == "V2_0"
    error_message = "ESSENTIALS katmaninda V2 kullanilmali"
  }
  assert {
    condition     = output.api_token_use == "access"
    error_message = "ESSENTIALS katmaninda access token kullanilmali"
  }
  assert {
    condition     = aws_cognito_user_pool.main.email_configuration[0].email_sending_account == "DEVELOPER" && aws_cognito_user_pool.main.email_configuration[0].source_arn == "arn:aws:ses:eu-central-1:123456789012:identity/ornek.com"
    error_message = "SES verilince DEVELOPER modu kullanilmali"
  }
  assert {
    condition     = length(aws_ses_identity_policy.cognito) == 1
    error_message = "SES kimligine Cognito gonderim politikasi eklenmeli"
  }
}

run "ses_requires_from_address" {
  command = plan

  variables {
    ses_identity_arn = "arn:aws:ses:eu-central-1:123456789012:identity/ornek.com"
  }

  expect_failures = [aws_cognito_user_pool.main]
}

# ---------------------------------------------------------------------------
# Online odeme (Adim 8b)
# ---------------------------------------------------------------------------

run "payments_disabled_by_default" {
  command = plan

  assert {
    condition     = length(aws_secretsmanager_secret.payments) == 0 && length(aws_apigatewayv2_route.payments_public) == 0
    error_message = "Varsayilan: online odeme kapali, secret ve kimliksiz odeme rotasi olusmamali"
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.api.environment[0].variables), "PAYMENTS_PROVIDER") && !contains(keys(aws_lambda_function.scheduler_worker.environment[0].variables), "PAYMENTS_PROVIDER")
    error_message = "Odeme kapaliyken Lambda'lara odeme yapilandirmasi verilmemeli"
  }
  assert {
    condition     = !contains(keys(aws_scheduler_schedule.jobs), "payment_reconcile")
    error_message = "Odeme kapaliyken mutabakat zamanlamasi olusmamali"
  }
  assert {
    condition     = length([for a in flatten([for st in data.aws_iam_policy_document.api.statement : st.actions]) : a if startswith(a, "secretsmanager:")]) == 0
    error_message = "Odeme kapaliyken API Lambda secret okuyamamali"
  }
  assert {
    condition     = output.payments_secret_arn == null && output.payments_callback_urls == null
    error_message = "Odeme kapaliyken odeme ciktilari bos olmali"
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.payment_needs_review) == 0 && length(aws_cloudwatch_metric_alarm.payment_refund_failed) == 0
    error_message = "Odeme kapaliyken odeme alarmlari olusmamali"
  }
}

run "payments_iyzico" {
  command = plan

  variables {
    environment                  = "dev"
    dynamodb_deletion_protection = false
    payments_provider            = "iyzico"
    web_app_url                  = "https://building-management-apx.pages.dev"
  }

  override_resource {
    target          = aws_secretsmanager_secret.payments
    override_during = plan
    values = {
      arn = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:building-management-dev/payments/iyzico-AbCdEf"
    }
  }

  # --- Secret: yalnizca kaynak; deger Terraform disinda ---
  assert {
    condition     = length(aws_secretsmanager_secret.payments) == 1 && aws_secretsmanager_secret.payments[0].name == "building-management-dev/payments/iyzico"
    error_message = "Secret adi <proje>-<ortam>/payments/<saglayici> olmali"
  }
  assert {
    condition     = aws_secretsmanager_secret.payments[0].recovery_window_in_days == 0
    error_message = "prod disinda secret aninda silinebilmeli"
  }

  # --- Kimliksiz rotalar: YALNIZCA iki tam yol ---
  assert {
    condition     = toset([for r in aws_apigatewayv2_route.payments_public : r.route_key]) == toset(["POST /api/payments/iyzico/callback", "POST /api/payments/iyzico/webhook"])
    error_message = "Kimliksiz odeme rotalari yalnizca iyzico callback ve webhook olmali"
  }
  assert {
    condition     = alltrue([for r in aws_apigatewayv2_route.payments_public : r.authorization_type == "NONE"])
    error_message = "Saglayici JWT tasimaz; callback/webhook rotalari kimliksiz olmali"
  }
  assert {
    condition     = aws_apigatewayv2_route.api.authorization_type == "JWT" && aws_apigatewayv2_route.api.route_key == "ANY /api/{proxy+}"
    error_message = "Diger tum rotalar JWT ile korunmaya devam etmeli"
  }
  assert {
    condition = (
      toset([for r in aws_apigatewayv2_stage.default.route_settings : r.route_key]) == toset(["POST /api/payments/iyzico/callback", "POST /api/payments/iyzico/webhook"]) &&
      alltrue([for r in aws_apigatewayv2_stage.default.route_settings : r.throttling_rate_limit == 5 && r.throttling_burst_limit == 10])
    )
    error_message = "Kimliksiz odeme rotalari siki throttling ile sinirlanmali"
  }

  # --- Lambda yapilandirmasi ---
  assert {
    condition = alltrue([
      for f in [aws_lambda_function.api, aws_lambda_function.scheduler_worker] :
      f.environment[0].variables.PAYMENTS_PROVIDER == "iyzico" &&
      f.environment[0].variables.IYZICO_BASE_URL == "https://sandbox-api.iyzipay.com" &&
      f.environment[0].variables.WEB_APP_URL == "https://building-management-apx.pages.dev" &&
      f.environment[0].variables.PAYMENTS_SECRET_ARN == "arn:aws:secretsmanager:eu-central-1:123456789012:secret:building-management-dev/payments/iyzico-AbCdEf"
    ])
    error_message = "API ve scheduler worker ayni odeme yapilandirmasini almali"
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.api.environment[0].variables), "IYZICO_API_KEY") && !contains(keys(aws_lambda_function.api.environment[0].variables), "IYZICO_SECRET_KEY")
    error_message = "Anahtarlar ortam degiskeninde olmamali (Secrets Manager)"
  }

  # --- IAM: yalnizca bu secret, yalnizca okuma ---
  assert {
    condition     = [for st in data.aws_iam_policy_document.api.statement : { actions = toset(st.actions), resources = toset(st.resources) } if anytrue([for a in st.actions : startswith(a, "secretsmanager:")])] == [{ actions = toset(["secretsmanager:GetSecretValue"]), resources = toset(["arn:aws:secretsmanager:eu-central-1:123456789012:secret:building-management-dev/payments/iyzico-AbCdEf"]) }]
    error_message = "API Lambda yalnizca odeme secret'ini okuyabilmeli (GetSecretValue, tek ARN)"
  }
  assert {
    condition     = [for st in data.aws_iam_policy_document.scheduler_worker.statement : { actions = toset(st.actions), resources = toset(st.resources) } if anytrue([for a in st.actions : startswith(a, "secretsmanager:")])] == [{ actions = toset(["secretsmanager:GetSecretValue"]), resources = toset(["arn:aws:secretsmanager:eu-central-1:123456789012:secret:building-management-dev/payments/iyzico-AbCdEf"]) }]
    error_message = "Scheduler worker yalnizca odeme secret'ini okuyabilmeli (GetSecretValue, tek ARN)"
  }

  # --- Mutabakat zamanlamasi ---
  assert {
    condition = (
      aws_scheduler_schedule.jobs["payment_reconcile"].schedule_expression == "rate(15 minutes)" &&
      aws_scheduler_schedule.jobs["payment_reconcile"].schedule_expression_timezone == null &&
      jsondecode(aws_scheduler_schedule.jobs["payment_reconcile"].target[0].input).job == "payment_reconcile"
    )
    error_message = "payment_reconcile 15 dakikada bir calismali"
  }
  assert {
    condition     = aws_scheduler_schedule.jobs["late_fees"].schedule_expression_timezone == "Europe/Istanbul"
    error_message = "Cron zamanlamalari Europe/Istanbul saat diliminde kalmali"
  }

  # --- Inceleme alarmi ---
  assert {
    condition     = length(aws_cloudwatch_log_metric_filter.payment_needs_review) == 2 && alltrue([for f in aws_cloudwatch_log_metric_filter.payment_needs_review : f.pattern == "\"PAYMENT_NEEDS_REVIEW\""])
    error_message = "API ve scheduler loglarindaki PAYMENT_NEEDS_REVIEW sayilmali"
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.payment_needs_review) == 1 && aws_cloudwatch_metric_alarm.payment_needs_review[0].threshold == 1
    error_message = "Incelemeye alinan ilk odemede alarm uretilmeli"
  }
  assert {
    condition     = length(aws_cloudwatch_log_metric_filter.payment_refund_failed) == 2 && alltrue([for f in aws_cloudwatch_log_metric_filter.payment_refund_failed : f.pattern == "\"PAYMENT_REFUND_FAILED\""])
    error_message = "Reddedilen iadeler API ve scheduler loglarinda sayilmali"
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.payment_refund_failed) == 1 && aws_cloudwatch_metric_alarm.payment_refund_failed[0].threshold == 1
    error_message = "Reddedilen ilk iadede alarm uretilmeli"
  }
  assert {
    condition     = output.payments_secret_arn == "arn:aws:secretsmanager:eu-central-1:123456789012:secret:building-management-dev/payments/iyzico-AbCdEf"
    error_message = "Secret ARN ciktisi verilmeli (deger girmek icin)"
  }
}

run "prod_payment_secret_recoverable" {
  command = plan

  variables {
    payments_provider = "iyzico"
    iyzico_base_url   = "https://api.iyzipay.com"
    web_app_url       = "https://app.ornek.com"
  }

  assert {
    condition     = aws_secretsmanager_secret.payments[0].name == "building-management/payments/iyzico" && aws_secretsmanager_secret.payments[0].recovery_window_in_days == 30
    error_message = "prod secret'i yanlislikla silinirse 30 gun geri alinabilmeli"
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.IYZICO_BASE_URL == "https://api.iyzipay.com"
    error_message = "Canli iyzico adresi Lambda'ya gecmeli"
  }
}

run "payments_requires_web_app_url" {
  command = plan

  variables {
    payments_provider = "iyzico"
  }

  expect_failures = [aws_secretsmanager_secret.payments]
}

run "rejects_fake_payment_provider" {
  command = plan

  variables {
    payments_provider = "fake"
  }

  expect_failures = [var.payments_provider]
}

run "rejects_invalid_payment_urls" {
  command = plan

  variables {
    iyzico_base_url = "https://evil.example.com"
    web_app_url     = "https://app.ornek.com/"
  }

  expect_failures = [var.iyzico_base_url, var.web_app_url]
}

run "notifications_ses" {
  command = plan

  variables {
    notification_channel  = "ses"
    ses_identity_arn      = "arn:aws:ses:eu-central-1:123456789012:identity/yonetimsistemim.com"
    ses_from_address      = "YÖNESİST <bildirim@yonetimsistemim.com>"
    ses_configuration_set = "bm-events"
    web_app_url           = "https://app.yonetimsistemim.com"
  }

  assert {
    condition = (
      aws_lambda_function.notification_worker.environment[0].variables.NOTIFICATION_CHANNEL == "ses" &&
      aws_lambda_function.notification_worker.environment[0].variables.SES_CONFIGURATION_SET == "bm-events" &&
      aws_lambda_function.notification_worker.environment[0].variables.WEB_APP_URL == "https://app.yonetimsistemim.com"
    )
    error_message = "SES kanali ortam degiskenleri eksik"
  }
  assert {
    condition     = [for st in data.aws_iam_policy_document.notification_worker.statement : { actions = toset(st.actions), resources = toset(st.resources) } if st.sid == "SendNotificationEmail"] == [{ actions = toset(["ses:SendEmail", "ses:SendRawEmail"]), resources = toset(["arn:aws:ses:eu-central-1:123456789012:identity/yonetimsistemim.com", "arn:aws:ses:eu-central-1:123456789012:configuration-set/bm-events"]) }]
    error_message = "Worker yalnizca dogrulanmis kimlik ve yapilandirma seti uzerinden e-posta gonderebilmeli"
  }
  assert {
    condition = anytrue([
      for c in one([for st in data.aws_iam_policy_document.notification_worker.statement : st.condition if st.sid == "SendNotificationEmail"]) :
      c.test == "StringEqualsIgnoreCase" && c.variable == "ses:FromAddress" && tolist(c.values) == tolist(["bildirim@yonetimsistemim.com"])
    ])
    error_message = "Gonderim yalnizca yapilandirilmis gonderen adresle sinirli olmali"
  }
}

run "notifications_ses_requires_identity" {
  command = plan

  variables {
    notification_channel = "ses"
  }

  expect_failures = [aws_lambda_function.notification_worker]
}

run "notifications_ses_identity_must_cover_sender" {
  command = plan

  variables {
    notification_channel = "ses"
    ses_identity_arn     = "arn:aws:ses:eu-central-1:123456789012:identity/ornek.com"
    ses_from_address     = "Bina Yonetim <no-reply@ornek.com>"
  }

  expect_failures = [aws_lambda_function.notification_worker]
}

run "rejects_unknown_notification_channel" {
  command = plan

  variables {
    notification_channel = "sms"
  }

  expect_failures = [var.notification_channel]
}
