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
    defaults = { arn = "arn:aws:dynamodb:eu-central-1:123456789012:table/mock" }
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
    defaults = { execution_arn = "arn:aws:execute-api:eu-central-1:123456789012:mockapi" }
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
      "DUE_GENERATED", "PAYMENT_RECEIVED", "ANNOUNCEMENT_PUBLISHED", "LATE_FEE_POSTED", "DUES_REMINDER",
    ]
    error_message = "Bildirim kuyrugu bes olay turune abone olmali (zamanlanmis gorev olaylari dahil)"
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
    condition     = aws_lambda_function.api.environment[0].variables.AUTH_MODE == "apigw" && aws_lambda_function.api.environment[0].variables.EVENTS_MODE == "sns"
    error_message = "Lambda AUTH_MODE=apigw ve EVENTS_MODE=sns ile calismali"
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
    condition     = alltrue([for s in aws_scheduler_schedule.jobs : s.schedule_expression_timezone == "Europe/Istanbul" && s.state == "ENABLED"])
    error_message = "Zamanlamalar Europe/Istanbul ve varsayilan acik olmali"
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
