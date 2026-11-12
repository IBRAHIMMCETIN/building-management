# Dev ortami degiskenleri. Her plan/apply'da verin:
#   terraform -chdir=infra plan "-var-file=dev.tfvars" "-out=dev.tfplan"
# Gizli bilgi icermez; repoda tutulur.
environment = "dev"

# 12.11.2026 olayindan sonra dev tablosu da korunur. Bilerek yikmak icin once false ile apply edin.
dynamodb_deletion_protection = true

cors_allow_origins = ["http://localhost:5173"]
