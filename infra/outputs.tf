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

output "audit_table_name" {
  description = "Degistirilemez denetim gunlugu tablosu (yalnizca ekle + oku)."
  value       = aws_dynamodb_table.audit.name
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
    # LITE katmaninda rol claim'leri yalnizca ID token'da: API'ye ID token gonderilmeli.
    VITE_COGNITO_TOKEN_USE = local.api_token_use
  }
}

output "notification_worker_function_name" {
  value = aws_lambda_function.notification_worker.function_name
}

output "api_token_use" {
  description = "API'ye gonderilecek Cognito token turu (id | access)."
  value       = local.api_token_use
}

output "outbox_relay_function_name" {
  value = aws_lambda_function.outbox_relay.function_name
}

output "outbox_relay_dlq_url" {
  value = aws_sqs_queue.outbox_relay_dlq.url
}

output "scheduler_worker_function_name" {
  value = aws_lambda_function.scheduler_worker.function_name
}

output "scheduled_jobs_queue_url" {
  description = "Elle tetikleme: aws sqs send-message --queue-url <bu> --message-body '{\"job\":\"late_fees\",\"scheduledTime\":\"2026-12-01T00:00:00Z\"}'"
  value       = aws_sqs_queue.jobs.url
}

output "documents_bucket" {
  description = "Private belge deposu (makbuz PDF, gider faturasi). Yerel API icin DOCUMENTS_BUCKET."
  value       = aws_s3_bucket.documents.id
}

output "payments_secret_arn" {
  description = "Online odeme anahtari secret'i (deger elle girilir: aws secretsmanager put-secret-value). Odeme kapaliysa null."
  value       = local.payments_secret_arn
}

output "payments_callback_urls" {
  description = "Saglayici paneline girilecek adresler (webhook / bildirim URL'si). Odeme kapaliysa null."
  value = local.payments_enabled ? {
    callback = "${aws_apigatewayv2_api.http.api_endpoint}/api/payments/${var.payments_provider}/callback"
    webhook  = "${aws_apigatewayv2_api.http.api_endpoint}/api/payments/${var.payments_provider}/webhook"
  } : null
}
