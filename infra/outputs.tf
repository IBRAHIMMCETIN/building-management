output "api_url" {
  description = "HTTP API taban adresi (ornek: <api_url>/api/health)."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "api_function_name" {
  value = aws_lambda_function.api.function_name
}

output "pre_token_function_name" {
  value = aws_lambda_function.pre_token.function_name
}

output "dynamodb_table_name" {
  value = aws_dynamodb_table.main.name
}

output "dynamodb_table_arn" {
  value = aws_dynamodb_table.main.arn
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_user_pool_client_id" {
  description = "React uygulamasinin kullanacagi istemci kimligi (gizli degil)."
  value       = aws_cognito_user_pool_client.web.id
}

output "cognito_issuer" {
  value = "https://${aws_cognito_user_pool.main.endpoint}"
}

output "events_topic_arn" {
  value = aws_sns_topic.events.arn
}

output "notification_queue_url" {
  value = aws_sqs_queue.notification.id
}

output "notification_queue_arn" {
  description = "Faz 5 bildirim worker'inin event source mapping'i icin."
  value       = aws_sqs_queue.notification.arn
}

output "notification_dlq_url" {
  value = aws_sqs_queue.notification_dlq.id
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

# React (.env) icin hazir degerler.
output "frontend_env" {
  value = {
    VITE_API_URL                  = aws_apigatewayv2_stage.default.invoke_url
    VITE_COGNITO_REGION           = local.region
    VITE_COGNITO_USER_POOL_ID     = aws_cognito_user_pool.main.id
    VITE_COGNITO_USER_POOL_CLIENT = aws_cognito_user_pool_client.web.id
  }
}
