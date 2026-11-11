# ---------------------------------------------------------------------------
# Lambda (ARM64 / Node.js 24) + IAM + API Gateway v2 (HTTP API).
#
# Paket: `npm --prefix apps/api run build:lambda` -> apps/api/dist/lambda/{api,pre-token}.mjs
# Bu dizin apply sirasinda zip'lenir; kod degisince source_code_hash degisir.
#
# Not: HTTP API'ye AWS WAF baglanamaz (yalnizca REST API). Uc koruma Cloudflare (WAF/DDoS)
# + bu dosyadaki stage throttling ile saglanir; ozel alan adi Cloudflare arkasina alinmalidir.
# ---------------------------------------------------------------------------

locals {
  lambda_dist_dir = coalesce(var.lambda_dist_dir, "${path.module}/../apps/api/dist/lambda")
  api_function    = "${local.name}-api"
  pre_token_fn    = "${local.name}-pre-token"
  gsi1_name       = "GSI1"
}

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = local.lambda_dist_dir
  output_path = "${path.module}/.build/lambda.zip"
  excludes    = ["*.map"]
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# Log gruplari fonksiyondan once olusturulur: saklama suresi kontrol altinda kalir ve
# Lambda'ya logs:CreateLogGroup yetkisi gerekmez.
resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.api_function}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "pre_token" {
  name              = "/aws/lambda/${local.pre_token_fn}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${local.name}-http-api"
  retention_in_days = var.log_retention_days
}

# ---------------------------------------------------------------------------
# API Lambda: IAM (en az yetki)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "api" {
  name               = local.api_function
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }

  # Append-only defter IAM seviyesinde de korunur: DeleteItem / BatchWriteItem / Scan YOK.
  # TransactWriteItems, icindeki islemlerin (Put/Update/ConditionCheck) yetkileriyle calisir.
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

  statement {
    sid       = "PublishDomainEvents"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.events.arn]
  }

  # Sakin daveti (/api/residents/invite): e-postayla kullanici bul / olustur. Yalnizca bu
  # havuz; silme, sifre sifirlama, group veya nitelik yazma yetkisi YOK.
  # Belgeler: makbuz PDF onbellegi ve fatura dosyalari. Silme YOK (gecici yuklemeleri S3
  # yasam dongusu temizler). HeadObject icin GetObject; 404 alabilmek icin onek sinirli
  # ListBucket. Imzali URL'ler bu rolun yetkisiyle calisir.
  statement {
    sid       = "DocumentObjects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.documents.arn}/apartments/*", "${aws_s3_bucket.documents.arn}/tmp/*"]
  }

  statement {
    sid       = "DocumentList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.documents.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["apartments/*", "tmp/*"]
    }
  }

  statement {
    sid       = "InviteResidents"
    actions   = ["cognito-idp:AdminGetUser", "cognito-idp:AdminCreateUser"]
    resources = [aws_cognito_user_pool.main.arn]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_iam_role_policy_attachment" "api_xray" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_lambda_function" "api" {
  function_name    = local.api_function
  description      = "Hono API (moduler monolit)"
  role             = aws_iam_role.api.arn
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  handler          = "api.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = var.api_lambda_memory_mb
  timeout          = var.api_lambda_timeout_seconds

  environment {
    variables = {
      NODE_ENV             = "production"
      APP_VERSION          = var.app_version
      AUTH_MODE            = "apigw"
      DYNAMODB_TABLE_NAME  = aws_dynamodb_table.main.name
      EVENTS_MODE          = "sns"
      EVENTS_SNS_TOPIC_ARN = aws_sns_topic.events.arn
      # Yalnizca davet icin (AUTH_MODE=apigw oldugundan kimlik dogrulamayi etkilemez).
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.main.id
      DOCUMENTS_BUCKET     = aws_s3_bucket.documents.id
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [
    aws_cloudwatch_log_group.api,
    aws_iam_role_policy.api,
  ]
}

resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name          = "${local.api_function}-errors"
  alarm_description   = "API Lambda hata veriyor (5 dakikada 5+ hata)."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.api.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# ---------------------------------------------------------------------------
# Pre Token Generation Lambda: yalnizca GSI1 okur
# ---------------------------------------------------------------------------

resource "aws_iam_role" "pre_token" {
  name               = local.pre_token_fn
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "pre_token" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.pre_token.arn}:*"]
  }

  statement {
    sid       = "ReadGrantsIndex"
    actions   = ["dynamodb:Query"]
    resources = ["${aws_dynamodb_table.main.arn}/index/${local.gsi1_name}"]
  }
}

resource "aws_iam_role_policy" "pre_token" {
  name   = "pre-token"
  role   = aws_iam_role.pre_token.id
  policy = data.aws_iam_policy_document.pre_token.json
}

resource "aws_lambda_function" "pre_token" {
  function_name    = local.pre_token_fn
  description      = "Cognito Pre Token Generation V2: apartmentId/role claim'leri"
  role             = aws_iam_role.pre_token.arn
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  handler          = "pre-token.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  # Cognito tetikleyicileri 5 sn icinde yanit vermelidir.
  timeout = 5

  environment {
    variables = {
      NODE_ENV            = "production"
      DYNAMODB_TABLE_NAME = aws_dynamodb_table.main.name
      GSI1_NAME           = local.gsi1_name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.pre_token,
    aws_iam_role_policy.pre_token,
  ]
}

# ---------------------------------------------------------------------------
# API Gateway v2 (HTTP API) + Cognito JWT authorizer
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "http" {
  name          = "${local.name}-http-api"
  protocol_type = "HTTP"
  description   = "Building management API (Hono on Lambda)"

  # Preflight icin ayrica kimliksiz OPTIONS rotasi gerekir (bkz. cors_preflight rotasi).
  cors_configuration {
    allow_origins  = var.cors_allow_origins
    allow_methods  = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
    allow_headers  = ["authorization", "content-type"]
    expose_headers = []
    max_age        = 3600
  }
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.http.id
  name             = "cognito-jwt"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  # Access token'da `aud` yoktur; API Gateway bu durumda `client_id` claim'ini dogrular.
  jwt_configuration {
    audience = [aws_cognito_user_pool_client.web.id]
    issuer   = "https://${aws_cognito_user_pool.main.endpoint}"
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 30000
}

# Kimlik dogrulamasiz tek uc: saglik kontrolu (en ozel rota onceliklidir).
resource "aws_apigatewayv2_route" "health" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /api/health"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "NONE"
}

# Diger tum API uclari JWT zorunlu. Rol/tenant kontrolu uygulama icindedir.
resource "aws_apigatewayv2_route" "api" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "ANY /api/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

# CORS preflight: tarayici OPTIONS isteginde Authorization gondermez. Bu rota olmadan
# OPTIONS da `ANY /api/{proxy+}` (JWT) rotasina duser ve 401 alir. Daha ozel rota onceliklidir.
resource "aws_apigatewayv2_route" "cors_preflight" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "OPTIONS /api/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = var.api_throttle_rate_limit
    throttling_burst_limit = var.api_throttle_burst_limit
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      time           = "$context.requestTime"
      ip             = "$context.identity.sourceIp"
      method         = "$context.httpMethod"
      path           = "$context.path"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      latencyMs      = "$context.responseLatency"
      integrationErr = "$context.integrationErrorMessage"
      authorizerErr  = "$context.authorizer.error"
      userId         = "$context.authorizer.claims.sub"
    })
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowHttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
