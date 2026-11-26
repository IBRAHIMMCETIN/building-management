# Prod dağıtım kontrol listesi

Prod yığını yalnızca `v*` etiketi (veya `main`/`v*` üzerinden `workflow_dispatch target=prod`) ile dağıtılır. Ayarlar `infra/prod.tfvars`'tadır; `production_guardrails = true` olduğu için güvensiz bir ayarla **plan hiç başlamaz** (`infra/environment.tf`).

## 0. İlk prod dağıtımından önce (bir kez)

- [ ] **Eski prod yığını kararı.** Prod state'i (`serverless/terraform.tfstate`) ve eski soneksiz `building-management` tablosu hâlâ duruyor. İlk `v*` etiketinden önce `workflow_dispatch target=prod` yalnızca **plan** için çalıştırılmalı (veya yerelde `-var-file=prod.tfvars` ile plan) ve plandaki *destroy / replace* satırları tek tek incelenmeli. Silme koruması açık; tablo plan tarafından silinmeye çalışılırsa apply durur.
- [ ] **GitHub `production` environment'ı**: gerekli onaylayıcı (required reviewer) tanımlı; `AWS_DEPLOY_ROLE_ARN` (OIDC) veya erişim anahtarı secret'ları prod hesabına yetkili.
- [ ] **`ALERT_EMAIL`** repo variable'ı (veya `production` environment variable'ı) dolu. Boşsa prod planı şu hatayla durur: *Prod'da alarm e-postası zorunlu*.
- [ ] **Cloudflare Pages prod projesi** oluşturuldu (dev projesinden ayrı; prod API'nin `frontend_env` çıktısıyla `VITE_*` değişkenleri). Gerçek `*.pages.dev` adresi `prod.tfvars` → `web_app_url` ve `cors_allow_origins` içine yazıldı (şu an yer tutucu: `https://yonetimsistemim.pages.dev`).
- [ ] Prod `VITE_AUTH_MODE` = `cognito` (mock değil).

## 1. Dağıtım

```bash
git tag v0.1.0 && git push origin v0.1.0
```

CI sırası: typecheck/test/`build:lambda` → `terraform fmt/validate/test` → `init` (prod state) → `plan -var-file=prod.tfvars` → `apply` → sağlık kontrolü (`/api/health` yeni SHA, korumalı uç 401, `cors_allow_origins` çıktısındaki her https adresi için CORS ön kontrolü).

## 2. Dağıtımdan hemen sonra

- [ ] **SNS alarm aboneliğini onayla.** Terraform aboneliği `PendingConfirmation` olarak oluşturur; `ALERT_EMAIL` kutusuna gelen *AWS Notification - Subscription Confirmation* e-postasındaki bağlantı tıklanmadan hiçbir alarm gelmez. Kontrol:
  ```bash
  aws sns list-subscriptions-by-topic --topic-arn "$(terraform -chdir=infra output -raw alerts_topic_arn)" \
    --query 'Subscriptions[].{Endpoint:Endpoint,Arn:SubscriptionArn}'
  ```
  `SubscriptionArn` değeri `PendingConfirmation` değil, bir ARN olmalı.
- [ ] Bir test alarmı: `aws cloudwatch set-alarm-state --alarm-name building-management-bulk-jobs-dlq-not-empty --state-value ALARM --state-reason test` → e-posta geldi mi (sonra `OK`).
- [ ] İlk `platform_admin` kullanıcısı (`npm run seed:admin`) ve TOTP kurulumu (prod'da `enforce`: TOTP'siz yönetici panele giremez).
- [ ] Eski veri taşındıysa gider tarih dizini: `npm run backfill:expense-index -w @bm/api -- --dry-run`, sonra `--dry-run`'sız (yönetici kimliği, `DYNAMODB_TABLE_NAME` prod tablosu).
- [ ] `scheduled-jobs` ve `bulk-jobs` DLQ'ları boş; `audit-run-missing` alarmı ertesi gün `OK`.

## 3. Alan adı alındığında (tek satır)

1. Cloudflare Pages prod projesine `app.yonetimsistemim.com` özel alan adını bağla (DNS Cloudflare'de).
2. `infra/prod.tfvars` → `# custom_domain = "yonetimsistemim.com"` satırının başındaki `#` kaldırılır.
3. Yeni `v*` etiketi. Etkisi: `https://app.yonetimsistemim.com` CORS'a eklenir, `web_app_url` (ödeme dönüşü, e-posta bağlantıları) bu adres olur. Sağlık kontrolü yeni adresin CORS'unu da doğrular.
4. Geçiş bitince `cors_allow_origins` içindeki `pages.dev` adresi silinir.

## 4. E-posta (SES) — alan adından sonra

README → *Canlıya Geçiş Kontrol Listesi* → *AWS SES e-posta aktivasyonu*: alan adı kimliği + DKIM/SPF/DMARC, sandbox'tan çıkış, ardından GitHub'da `SES_IDENTITY_ARN` / `SES_FROM_ADDRESS` ve `prod.tfvars` → `notification_channel = "ses"`. Bu adım tamamlanmadan Cognito günde ~50 davet e-postasıyla sınırlıdır (pilot sakin davetleri için kritik).

## 5. Online ödeme — en son

Güvenli başlangıç: `payments_provider = "disabled"`. Sıra:
1. `payments_providers = ["iyzico"]` + sandbox adresi; `terraform output payments_secret_arns` → Secrets Manager'a anahtarlar; iyzico paneline `payments_callback_urls` webhook'u.
2. Sözleşme oranları: `payments_pos_rate_bps`, `payments_pos_fixed_fee_kurus`.
3. Canlı: `iyzico_base_url = "https://api.iyzipay.com"` (PayTR için `paytr_test_mode = false`). Korkuluk, alan adı (`custom_domain`) ve komisyon oranı yoksa planı durdurur.

## Prod korkulukları (`environment.tf`)

| Kural | Neden |
| --- | --- |
| `environment = "prod"` | Korkuluk yalnızca prod state'iyle |
| `mfa_enforcement_mode = "enforce"` | Yönetici / finans rolleri TOTP'siz giremez |
| `alert_email` dolu | DLQ, defter sapması, denetim zinciri alarmları bir yere gitmeli |
| CORS yalnızca `https://`, localhost yok | Prod API yerel geliştirme kökenine açılmaz |
| `web_app_url` veya `custom_domain` | E-posta / ödeme dönüş bağlantıları |
| `dynamodb_deletion_protection = true` | 12.11.2026 olayı |
| `scheduler_enabled = true` | Aidat, gecikme tazminatı, gece denetimi |
| `cognito_admin_create_user_only = true` | Açık kayıt kapalı |
| `notification_channel = "ses"` → `ses_identity_arn` | Doğrulanmamış SES ile gönderim yok |
| Canlı ödeme → alan adı + komisyon oranı | Sandbox dışına erken çıkış yok |
