# Dev ortami degiskenleri. Her plan/apply'da verin:
#   terraform -chdir=infra plan "-var-file=dev.tfvars" "-out=dev.tfplan"
# Gizli bilgi icermez; repoda tutulur.
environment = "dev"

# 12.11.2026 olayindan sonra dev tablosu da korunur. Bilerek yikmak icin once false ile apply edin.
dynamodb_deletion_protection = true

# API Gateway CORS + S3 belge bucket CORS (api.tf, storage.tf) bu listeyi kullanir.
# Cloudflare Pages: production (main) + sabit preview dal adresi. Hash'li preview
# URL'leri (abc123.building-management-apx.pages.dev) bilincli olarak listede yok.
cors_allow_origins = [
  "http://localhost:5173",
  "https://building-management-apx.pages.dev",
  "https://feature-adim-7-web-ekranlari.building-management-apx.pages.dev",
]

# Online odeme (Adim 8b): iyzico sandbox. Anahtar Terraform disinda Secrets Manager'a girilir
# (bkz. payments.tf ve `terraform output payments_secret_arn`).
payments_provider = "iyzico"
iyzico_base_url   = "https://sandbox-api.iyzipay.com"
web_app_url       = "https://building-management-apx.pages.dev"
