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
    condition     = aws_cognito_user_pool.main.user_pool_tier == "ESSENTIALS"
    error_message = "Pre Token V2 icin ESSENTIALS gerekli"
  }
  assert {
    condition     = aws_cognito_user_pool.main.lambda_config[0].pre_token_generation_config[0].lambda_version == "V2_0"
    error_message = "Pre Token Generation V2 bagli olmali"
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
      "DUE_GENERATED", "PAYMENT_RECEIVED", "ANNOUNCEMENT_PUBLISHED",
    ]
    error_message = "Bildirim kuyrugu uc olay turune abone olmali"
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
    condition     = aws_apigatewayv2_integration.api.payload_format_version == "2.0"
    error_message = "Hono aws-lambda adaptoru payload v2 bekler"
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

run "rejects_lite_tier" {
  command = plan

  variables {
    cognito_user_pool_tier = "LITE"
  }

  expect_failures = [var.cognito_user_pool_tier]
}
