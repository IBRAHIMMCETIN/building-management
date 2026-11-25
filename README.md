# Building Management — Dijital Site ve Aidat Yönetim Sistemi

Türkiye'deki apartman, site ve profesyonel yönetim firmaları için çok kiracılı (multi-tenant), sunucusuz bir site ve aidat yönetim platformu. Kat Mülkiyeti Kanunu'na uygun alt cari (malik / kiracı) ayrımı, dağıtım anahtarlarıyla toplu tahakkuk ve değişmez (append-only) finansal defter üzerine kuruludur.

> **Durum (22.11.2026):** Aktif geliştirme. Backend çekirdeği, yönetici ve sakin web ekranları, kıstelyevm, belge deposu ve toplu aktarım `main` dalında; `dev` ortamı AWS `eu-north-1` bölgesinde, web Cloudflare Pages üzerinde canlı. Online ödeme (Adım 8b ve v2 P1–P5: iyzico + PayTR, komisyon, şifreli IBAN, aktarımlar, platform faturası), taşınmada cari kapama / borç devri, güvenilir olay ve bildirim hattı ile güvenlik sertleştirmesi G1–G2 (denetim günlüğü, zorunlu MFA) `main`'e alındı. Canlı ödeme aktivasyonu (şirket ve iyzico/PayTR ticari başvuruları), SES ve G3 (Cloudflare WAF) alan adı ve başvurular tamamlanana kadar bekliyor ([Canlıya Geçiş Kontrol Listesi](#canlıya-geçiş-kontrol-listesi)). Banka ekstresi aktarımı ve eşleştirme Faz B1–B3.5 `main`'de (`6e2eb18`); **Finans 2.1** (hisseli mülkiyet, mülk/hisse devri, paydaş carileri) `main`'de (`d83e07f`); **Finans 2.2** (avans mahsubu, borç yapılandırma / taksit planı, muacceliyet) `feature/finance-offset-restructure` dalında: backend doğrulandı, web yerel doğrulama bekliyor. Faz B4 (online tahsilat aktarım mutabakatı) canlı ödeme aktivasyonundan sonra. Ayrıntılar için [Yol Haritası](#yol-haritası).

---

## İçindekiler

- [Mimari](#mimari)
- [Repo Yapısı](#repo-yapısı)
- [Gereksinimler](#gereksinimler)
- [Yerel Geliştirme](#yerel-geliştirme)
- [Ortam Değişkenleri](#ortam-değişkenleri)
- [Test](#test)
- [Altyapı (Terraform)](#altyapı-terraform)
- [CI/CD](#cicd)
- [İlk Kurulum (Bootstrap)](#ilk-kurulum-bootstrap)
- [API Modülleri](#api-modülleri)
- [Roller ve Yetkilendirme](#roller-ve-yetkilendirme)
- [Güvenlik ve izleme](#güvenlik-ve-izleme)
- [Finansal Kurallar](#finansal-kurallar)
- [Yol Haritası](#yol-haritası)

---

## Mimari

```
React (Vite, PWA)  ──►  API Gateway (HTTP API, JWT authorizer, throttling)
                                │
                                ▼
                     API Lambda — Modüler Monolit (Hono)
                      │            │              │
                      ▼            ▼              ▼
                 DynamoDB     SNS (olaylar)   Cognito ◄── Pre Token Generation Lambda
               (single-table)      │                     (apartmentId / role claim'leri)
                                   ▼
                              SQS (+ DLQ)
                                   │
                                   ▼
                       Bildirim Worker Lambda
```

| Katman | Teknoloji |
| --- | --- |
| Frontend | React 19 + Vite, Cloudflare Pages (Git entegrasyonu): https://building-management-apx.pages.dev |
| API | Node.js 24, [Hono](https://hono.dev) + `@hono/aws-lambda`, AWS Lambda (arm64) |
| Kimlik | Amazon Cognito + Pre Token Generation trigger, `aws-jwt-verify` |
| Veritabanı | Amazon DynamoDB (single-table, `apartmentId` bazlı izolasyon) |
| Olaylar | Amazon SNS → SQS (DLQ ile), EventBridge |
| Altyapı | Terraform (`infra/`), uzak state: S3 backend |
| CI/CD | GitHub Actions (OIDC ile AWS erişimi) |
| Test | Vitest + `aws-sdk-client-mock`, `terraform test` (mock provider) |

Domain olayları API'den doğrudan yayınlanmaz: defter yazımıyla aynı atomik işlemde `OUTBOX#` kaydı olarak yazılır; **DynamoDB Streams → outbox-relay Lambda → SNS** hattı yayınlar (transactional outbox).

AWS SDK yalnızca **v3** (`@aws-sdk/client-*`) kullanılır.

---

## Repo Yapısı

```
building-management/
├── apps/
│   ├── api/                      # @bm/api — modüler monolit API
│   │   ├── src/
│   │   │   ├── app.ts            # Hono uygulaması, rota kaydı
│   │   │   ├── lambda.ts         # API Lambda giriş noktası
│   │   │   ├── lambda-pre-token.ts  # Cognito Pre Token Generation
│   │   │   ├── server.ts         # Yerel Node sunucusu
│   │   │   ├── auth/             # JWT doğrulama, claim'ler, pre-token mantığı
│   │   │   ├── config/           # DynamoDB istemcisi ve yardımcıları
│   │   │   ├── events/           # SNS/EventBridge olay yayıncısı
│   │   │   ├── http/             # Hata ve yardımcı fonksiyonlar
│   │   │   ├── modules/          # Domain modülleri (core, finance, portal, ...)
│   │   │   └── workers/          # SQS tüketen worker Lambda'lar
│   │   ├── scripts/seed-admin.ts # İlk yönetici kurulum betiği
│   │   └── test/                 # Vitest testleri
│   └── web/                      # @bm/web — React + Vite
├── infra/                        # Serverless Terraform yığını
│   ├── api.tf  cognito.tf  dynamodb.tf  sns_sqs.tf  worker.tf  outbox.tf  operations.tf
│   ├── tests/serverless.tftest.hcl
│   ├── github-oidc/              # GitHub Actions için OIDC rolü
│   ├── budget/                   # AWS bütçe alarmı
│   └── ec2/, hello-lambda/       # Eski / deneysel dağıtım yolları
├── .github/workflows/            # CI/CD pipeline'ları
└── scripts/                      # CI yardımcıları, sürüm betiği
```

Kök dizin bir npm workspaces monoreposudur (`apps/*`).

---

## Gereksinimler

- **Node.js ≥ 24** (CI: 24.22.x)
- **npm** (workspaces)
- **Terraform ~1.17**
- AWS hesabı ve yetkili kimlik bilgileri (yalnızca dağıtım ve bootstrap için)

---

## Yerel Geliştirme

```bash
npm install

# API (tsx watch, varsayılan port 3000)
npm run dev:api

# Web (Vite, varsayılan port 5173)
npm run dev:web
```

### Mock modda yerel çalışma (Cognito olmadan)

API ve web `mock` kimlik moduyla çalışır (**yalnızca yerel**; production/Lambda ortamında reddedilir). Veritabanı olarak AWS'de, Terraform'dan bağımsız ve adı `-local` ile biten bir geliştirme tablosu kullanılır.

```powershell
# 1) Konsol oturumuyla CLI girişi (12 saat geçerli); kimliği bu terminale aktar
aws login --profile console
aws configure export-credentials --profile console --format powershell | Invoke-Expression

# 2) Ortam (aynı terminal)
$env:AUTH_MODE="mock"; $env:AWS_REGION="eu-north-1"; $env:DYNAMODB_TABLE_NAME="building-management-local"

# 3) Tablo + örnek site (apt-dev-1) + bloklar; tekrar çalıştırılabilir
npm run db:init

# 4) API
npm run dev:api
```

`apps/web/.env.local` içinde `VITE_AUTH_MODE=mock` olmalıdır. Mock modda sakin daveti Cognito'ya gitmez: geçici şifre API konsoluna ve davet sonucuna yazılır.

> `db:init` Terraform'un yönettiği tablolara (adı `-local` ile bitmeyen) dokunmaz. Resmi DynamoDB Local (Docker/Java) kullanmak için `DYNAMODB_ENDPOINT=http://localhost:8000` verin. `dynalite` gibi emülatörler `TransactWriteItems` desteklemediği için finans defteri onlarda çalışmaz.

### Kök komutlar

| Komut | Açıklama |
| --- | --- |
| `npm run typecheck` | Tüm workspace'lerde `tsc --noEmit` |
| `npm test` | Tüm workspace testleri |
| `npm run build` | Tüm workspace build'leri |
| `npm run release` | Sürüm paketi oluşturur (`scripts/make-release.mjs`) |

### API komutları (`apps/api`)

| Komut | Açıklama |
| --- | --- |
| `npm run dev -w @bm/api` | Yerel geliştirme sunucusu |
| `npm run build:lambda -w @bm/api` | `dist/lambda/` altına `api.mjs`, `pre-token.mjs`, `notification-worker.mjs` (esbuild, ESM) |
| `npm run seed:admin -w @bm/api` | İlk kurulum betiği (bkz. [Bootstrap](#ilk-kurulum-bootstrap)) |

---

## Ortam Değişkenleri

### API

| Değişken | Açıklama |
| --- | --- |
| `AUTH_MODE` | `cognito` \| `apigw` \| `mock` \| `deny`. Verilmezse `COGNITO_USER_POOL_ID` varsa `cognito`, yoksa `deny` (tüm korumalı uçlar 401). |
| `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` | `cognito` modu için zorunlu. |
| `COGNITO_TOKEN_USE` | `access` (varsayılan) veya `id`. Özel claim'ler access token'dadır. |
| `DYNAMODB_TABLE_NAME` | Tek tablo adı. |
| `DYNAMODB_ENDPOINT` | Opsiyonel; DynamoDB Local için. |
| `AWS_REGION` | AWS bölgesi. |
| `APP_VERSION` | Sağlık kontrolünde dönen sürüm (CI'da commit SHA). |
| `PORT` | Yerel sunucu portu (varsayılan `3000`). |
| `EVENTS_MODE` | Yalnızca yayın yapan süreçler: outbox relay ve zamanlayıcı Lambda'ları (`sns`), yerel sunucunun outbox relay'i (`local`, varsayılan; `none` kapatır). API Lambda'sı olay yayınlamaz. |
| `NOTIFICATION_CHANNEL` | Bildirim worker'ı: `log` (varsayılan, dış gönderim yok) veya `ses` (e-posta). |
| `SES_FROM_ADDRESS` | Bildirim e-postalarının göndereni (varsayılan `YÖNESİST <bildirim@yonetimsistemim.com>`; ASCII dışı görünen ad MIME ile kodlanır). |
| `SES_CONFIGURATION_SET` | İsteğe bağlı SES yapılandırma seti (geri dönüş/şikâyet olayları). |
| `WEB_APP_URL` | E-postalardaki portal bağlantılarının kökü (`<WEB_APP_URL>/app/...`); yalnızca `https`. |
| `OUTBOX_LOCAL_RELAY` | Yerel sunucuda `off` ise bekleyen outbox kayıtlarını yoklayan bellek içi relay çalışmaz. |
| `MFA_ENFORCEMENT_MODE` | Yönetici/denetçi rolleri için zorunlu TOTP: `off` (varsayılan, yerel) \| `warn` (kullanıcı bazlı geçiş süresi, sonra zorunlu) \| `enforce`. API ve Pre Token Lambda'sında aynı değer (Terraform `mfa_enforcement_mode`, varsayılan `warn`). Geçersiz değer başlangıçta hata verir. |
| `MFA_GRACE_PERIOD_DAYS` | `warn` modunda TOTP kurmamış kullanıcıya tanınan gün (varsayılan `7`, 0-90; Terraform `mfa_grace_period_days`). |
| `PAYMENTS_PROVIDERS` | Açık online ödeme sağlayıcıları, virgülle: `iyzico`, `paytr` (P3), `fake` (yalnızca yerel). Boş veya `disabled`: online ödeme kapalı. Eski tekil `PAYMENTS_PROVIDER` da okunur. Terraform `payments_provider`'dan üretir. |
| `DEFAULT_PAYMENT_PROVIDER` | Apartman tercihi yoksa kullanılan sağlayıcı; açık sağlayıcılardan biri olmalı. Birden fazla sağlayıcı açıkken zorunlu. Apartman bazında tercih: `PUT /api/admin/payments/apartments/{id}/settings`. |
| `IYZICO_BASE_URL` / `IYZICO_SECRET_ARN` | iyzico API adresi (sandbox/canlı) ve anahtarların Secrets Manager ARN'i (eski ad `PAYMENTS_SECRET_ARN` da okunur). Yerelde `IYZICO_API_KEY` / `IYZICO_SECRET_KEY`. |
| `PAYEE_KMS_KEY_ID` | P4: apartman aktarım alıcısını (IBAN + hesap sahibi) şifreleyen müşteri yönetimli KMS anahtarı (Terraform `payee_kms_key_arn`). API yalnızca şifreler (`kms:Encrypt`), çözme (`kms:Decrypt`) yalnızca transferi gönderen scheduler worker'da; ikisi de `purpose = payment-payee` bağlamına koşullu. Yerelde verilmezse bellek içi anahtar; production'da anahtarsız alıcı saklanamaz. |
| `PAYTR_TRANSFER_DELAY_HOURS` | P4: PayTR ödeme onayından sonra Platform Transfer talimatı için bekleme (0-720, varsayılan 24; Terraform `paytr_transfer_delay_hours`). Talimat en erken ödemenin ertesi günü (İstanbul) verilir. |
| `PLATFORM_INVOICE_MODE` / `PLATFORM_INVOICE_VAT_BPS` / `PLATFORM_INVOICE_VAT_MODE` | P4: platform komisyon faturası taslağı: `monthly` (varsayılan) \| `per_payment`; KDV baz puan (varsayılan `2000` = %20); `inclusive` (varsayılan; kesilen platform payı KDV dahil, fatura toplamı = defterdeki platform payı) \| `exclusive` (pay + KDV). |
| `PAYTR_SECRET_ARN` / `PAYTR_TEST_MODE` | PayTR mağaza anahtarları (Secrets Manager JSON `{"merchantId","merchantKey","merchantSalt"}`) ve `test_mode` (`1` varsayılan, canlıda `0`; Terraform `paytr_test_mode`). Yerelde `PAYTR_MERCHANT_ID` / `PAYTR_MERCHANT_KEY` / `PAYTR_MERCHANT_SALT`. |
| `PAYMENTS_POS_RATE_BPS` / `PAYMENTS_POS_FIXED_FEE_KURUS` | Online ödeme sağlayıcısının sözleşme komisyonu: oran baz puan (`249` = %2,49; 0-1000) ve işlem başı sabit ücret kuruş (`25` = 0,25 TL; 0-5000). Varsayılan `0`; geçersiz değer başlangıçta hata verir. Komisyon tahmininde kullanılır, ödeme hesabı bazında geçersiz kılınabilir (Terraform `payments_pos_rate_bps`, `payments_pos_fixed_fee_kurus`). |
| `BANK_IBAN_MAC_KEY_ID` | Faz B1: banka ekstresindeki karşı taraf IBAN'ının HMAC özeti için müşteri yönetimli KMS `HMAC_256` anahtarı (Terraform `bank_iban_mac_key_arn`). API yalnızca `kms:GenerateMac` (`HMAC_SHA_256`) yapar; düz IBAN hiçbir kayda yazılmaz. Yerelde verilmezse deterministik bellek içi HMAC (`BANK_IBAN_MAC_LOCAL_KEY` ile değiştirilebilir); production'da anahtarsız ekstre aktarılamaz (503). |
| `AUDIT_TABLE_NAME` | Denetim günlüğü tablosu (Terraform: `<proje>-<ortam>-audit`). Lambda'da tanımsızsa hassas yazımlar reddedilir (fail closed); yerel geliştirme ve testlerde tanımsızsa denetim atlanır. |

Gizli bilgiler koda gömülmez; AWS kimlik bilgileri SDK'nın varsayılan credential zincirinden gelir.

---

## Test

```bash
# API birim testleri (Vitest)
npm test -w @bm/api

# Terraform plan testleri (AWS kimlik bilgisi gerektirmez, mock provider)
terraform -chdir=infra init -backend=false
terraform -chdir=infra test
```

Terraform testleri `command = plan` ile çalışır. Plan aşamasında bilinmesi gereken hesaplanmış değerler (ör. SQS ARN'i) `override_resource { override_during = plan }` ile sabitlenir.

---

## Altyapı (Terraform)

Serverless yığın `infra/` kök modülündedir:

| Dosya | Kaynaklar |
| --- | --- |
| `api.tf` | HTTP API Gateway, JWT authorizer, rotalar (`ANY /api/{proxy+}`, açık `GET /api/health`), API Lambda |
| `cognito.tf` | User Pool, client, Pre Token Generation Lambda, `platform_admin` grubu, opsiyonel SES |
| `dynamodb.tf` | Tek tablo, GSI'lar, PITR, silme koruması |
| `sns_sqs.tf` | Olay topic'i, bildirim kuyruğu + DLQ, alarm topic'i |
| `worker.tf` | Bildirim worker Lambda ve SQS event source mapping |
| `outbox.tf` | Transactional outbox relay: tablo akışı (`NEW_IMAGE`) → yalnızca `OUTBOX#` INSERT filtresi → relay Lambda → SNS; DLQ, hata/gecikme alarmları, en az yetkili rol |
| `operations.tf` | Platform alarmları (EMF özel metrikleri, `BuildingManagement` / `Stack`): `LedgerDrift` (gecelik defter denetimi sapması), `OutboxSweepFailed`, `OutboxOldestPendingSeconds`, `BankReconDiff` (Faz B3: banka mutabakatında bekleyen satırlarla açıklanamayan fark, kuruş; eşik `bank_recon_diff_alarm_threshold`, varsayılan 0) |
| `audit.tf` | Değiştirilemez denetim tablosu (yalnızca ekleme; güncelleme/silme IAM ve kaynak politikasında reddedilir), 10 yıl TTL, PITR |
| `security_monitoring.tf` | Hassas uçlar için ayrı JWT rotaları + rota bazlı throttling; giriş hatası, MFA, API 5xx, denetim zinciri ve gece denetimi alarmları (bkz. [Güvenlik ve izleme](#güvenlik-ve-izleme)) |
| `bank.tf` | Faz B1: banka ekstresi karşı taraf IBAN HMAC anahtarı (`HMAC_256`, `GENERATE_VERIFY_MAC`) ve alias `<yığın>-bank-iban-hmac`. HMAC anahtarlarında otomatik döndürme yoktur; anahtar silinmemeli (eski özetler eşleşmez) |

Önemli değişkenler: `environment` (`prod` / `staging`), `alert_email`, `cors_allow_origins`, `cognito_user_pool_tier` (`LITE` / `ESSENTIALS`), `ses_identity_arn`, `ses_from_address`, `api_throttle_rate_limit`, `api_throttle_burst_limit`, `mfa_enforcement_mode`, `mfa_grace_period_days`; hassas rota sınırları ve güvenlik alarm eşikleri ([Güvenlik ve izleme](#güvenlik-ve-izleme)).

Elle dağıtım:

```bash
npm run build:lambda -w @bm/api
terraform -chdir=infra init -backend-config="bucket=<state-bucket>" -backend-config="key=serverless/terraform.tfstate" -backend-config="region=eu-central-1"
terraform -chdir=infra plan
terraform -chdir=infra apply
```

Çıktılar: `api_url`, `cognito_user_pool_id`, `cognito_user_pool_client_id`, `dynamodb_table_name`, `notification_queue_url`, `frontend_env` ve diğerleri.

---

## CI/CD

`.github/workflows/serverless-deploy.yml`:

- **Her push / PR** (`main`, `feature/aws-entegrasyonu`): typecheck, test, `build:lambda`, `terraform fmt` / `validate` / `test`.
- **Kimlik bilgisi varsa:** `terraform plan` (adım özetine yazılır).
- **Yalnızca `main`'e push:** `terraform apply` + sağlık kontrolü (`production` environment).

Web (Cloudflare Pages, Git entegrasyonu): `main`'e her push'ta Cloudflare kendisi derler ve yayınlar. Derleme değişkenleri Pages proje ayarlarındadır (**Production** → prod yığınının `frontend_env` çıktısı, **Preview** → dev yığınının). Canlı adres `serverless-deploy.yml`'deki varsayılan CORS listesindedir; sağlık kontrolü her deploy'da `https` adreslerinin API'ye CORS iznini doğrular.

AWS erişimi tercihen OIDC ile sağlanır (`infra/github-oidc`, repo variable `AWS_DEPLOY_ROLE_ARN`). Opsiyonel repo variable'ları: `AWS_REGION`, `ALERT_EMAIL`, `CORS_ALLOW_ORIGINS` (JSON liste), `COGNITO_USER_POOL_TIER`, `SES_IDENTITY_ARN`, `SES_FROM_ADDRESS`.

**Dağıtım yetkisi (en az yetki).** Bugün CI `github-deploy` IAM kullanıcısıyla çalışır. Politikanın tek kaynağı `infra/modules/deploy-policy` modülüdür; `infra/github-deploy-user` ve `infra/github-oidc` aynı modülü kullanır. Yığına yeni bir AWS kaynak türü eklendiğinde yetki bu modüle eklenir ve modül yönetici kimlik bilgileriyle elle yeniden uygulanır:

```bash
terraform -chdir=infra/github-deploy-user init -backend-config=... # bkz. main.tf başlığı
terraform -chdir=infra/github-deploy-user apply
```

| İfade | Neden |
| --- | --- |
| `ApiGatewayAccessLogDelivery` | HTTP API stage erişim logu (`access_log_settings`) oluşturulurken veya güncellenirken API Gateway, CloudWatch Logs "log delivery" kaydını çağıranın yetkisiyle yönetir: `logs:CreateLogDelivery`, `GetLogDelivery`, `UpdateLogDelivery`, `DeleteLogDelivery`, `ListLogDeliveries`, `PutResourcePolicy`, `DescribeResourcePolicies`. Bu eylemler kaynak düzeyinde kısıtlanamaz (`*`). |

> AWS konsolunda geçici olarak elle eklenen inline politika varsa (ör. `logs:CreateLogDelivery` için), modül yeniden uygulandıktan ve bir dev dağıtımı geçtikten sonra kaldırılmalıdır; aksi halde yetkiler repoda görünmeyen bir kaynağa dağılır.

---

## İlk Kurulum (Bootstrap)

API'deki tüm yazma uçları bir apartman bağlamı (JWT'de `apartmentId` + `role`) gerektirdiği için ilk site ve ilk yönetici betikle oluşturulur. Betik doğrudan Cognito + DynamoDB'ye yazar ve **idempotent**'tir.

```bash
cd apps/api
export AWS_REGION=eu-central-1
export COGNITO_USER_POOL_ID=$(terraform -chdir=../../infra output -raw cognito_user_pool_id)
export DYNAMODB_TABLE_NAME=$(terraform -chdir=../../infra output -raw dynamodb_table_name)

npm run seed:admin -- --admin-email ops@ornek.com \
  --manager-email yonetici@ornek.com \
  --site-name "Lale Apartmanı" --city İstanbul --district Kadıköy --address "Moda Cd. 1"

# Var olan siteye yönetici eklemek için: --apartment-id <siteId>
# Yalnızca planlamak için:             --dry-run
```

Kullanıcılara Cognito geçici şifre e-postası gider; ilk girişte şifre değiştirilir.

---

## API Modülleri

Tüm uçlar `/api` altındadır. `GET /api/health` dışındakiler JWT ile korunur.

| Modül | Önek | Kapsam |
| --- | --- | --- |
| `health` | `/api/health` | Sağlık ve sürüm bilgisi |
| `me` | `/api/me` | Oturum sahibinin seçebileceği apartman/rol bağlamları (`GET /contexts`); bildirim tercihleri (`GET\|PUT /notification-preferences`, `{ email: { enabled } }`, varsayılan açık); iki adımlı doğrulama (`GET /mfa`, `POST /mfa/totp/setup`, `POST /mfa/totp/verify`; kullanıcının Cognito access token'ı `X-Cognito-Access-Token` başlığında). **Rol claim'i gerektirmez**: bağlam seçilmeden önce ve MFA zorunluyken de çalışır |
| `core` | `/api/sites` | Site, blok ve bağımsız bölüm (daire/dükkan) yönetimi; m², arsa payı, sayaç kuralları |
| `finance` | `/api/finance` | Hesaplar, toplu aidat tahakkuku, tahsilat, gider, ters kayıt, bakiye; Faz B3.5 tedarikçi borcu: `GET /payables` (açık borç, faturalanan/ödenen, açık faturalar FIFO), `POST /payables/:accountId/payments` `{ idempotencyKey, fundsAccountId, amount, date?, description?, reference? }` (açık borcu aşan ödeme reddedilir); raporlar: `GET /summary`, `/dues-status` (FIFO gecikme), `/transactions` (sayfalı), `/former-accounts` (ayrılan sakin carileri). Taşınmada cari kapama: `GET /units/:unitId/closures/preview`, `GET\|POST /units/:unitId/closures`, `GET /closures/:closureId`, `POST /closures/:closureId/reverse`; Finans 2.2: `POST /offsets/preview`, `POST /offsets` `{ idempotencyKey, sourceAccountId, targetAccountId, amount, settles?, consent?, reason }`, `GET /offsets`, `POST /offsets/:id/reverse`, `GET /offset-requests`, `POST /offset-requests/:id/approve\|reject`, `GET /plans/open-items?accountId=`, `POST /plans/preview`, `POST /plans` `{ idempotencyKey, accountId, chargeIds, installments, firstDueDate, includeLateFees?, rule?, reason }`, `GET /plans`, `GET /plans/:id`, `POST /plans/:id/accelerate\|pull-forward\|cancel` |
| `memberships` | `/api/memberships` | Kullanıcı–daire bağlantıları (malik / kiracı); mülkiyet sicili olan bölümde hisse payı yalnızca devir veya sicil düzeltmesiyle değişir (409) |
| `ownership` | `/api/ownership` | Finans 2.1 hisseli mülkiyet: `GET /units/:unitId?date=` (pay tablosu kesir + bps, faturalama modu, temsilci, geçmiş), `PUT /units/:unitId/register` (elle sicil / hisse tamamlama), `PUT /units/:unitId/billing` `{ mode: joint\|split, reason, version }`, `PUT /units/:unitId/representative`, `POST /units/:unitId/transfers/preview`, `POST /units/:unitId/transfers` `{ idempotencyKey, kind: sale_full\|share_partial\|inheritance, effectiveDate, moves[{fromUserId,toUserId,share}], debtTo?: former\|new_owner, residents?, reason }`, `GET /units/:unitId/transfers`, `GET /transfers/:id`, `POST /transfers/:id/reverse`, `GET /issues`, `POST /backfill`, `GET /voting-roll?date=`. Yazma: `apartment_manager`, `management_company`; okuma: + `observer` |
| `residents` | `/api/residents` | Apartmanın kişileri (ad / e-posta, denetçiye maskeli) ve `POST /invite`: e-postayla Cognito kullanıcısı bul/oluştur + üyelik ata |
| `apartment-roles` | `/api/apartment-roles` | Apartman bazlı personel ve yönetici rolleri. Faz 1 (Ekip): `POST /invite` `{ email, fullName, role, startDate?, endDate? }` (Cognito kullanıcısını bulur/oluşturur; pasif kaydı yeniden etkinleştirir), `POST /:userId/:role/end` `{ version, reason, endDate? }` (gerekçe denetime yazılır), `POST /:userId/:role/resend-invite`. **Son yönetici koruması:** güncel `apartment_manager`/`management_company` kalmayacaksa bitirme, pasife alma ve bitişi öne çekme 409. Denetçi e-postaları maskeli görür. Web: `/admin/team`, `Hesabım` (`/admin/account`, `/app/account`) |
| `announcements` | `/api/announcements` | Duyuru oluşturma, onay, arşiv |
| `portal` | `/api/portal` | Sakin ekranı: `my-unit`, `my-dues`, `my-statement`, `my-receipts`, duyurular; Finans 2.2: `my-plans`, `offset-options`, `GET\|POST offset-requests` |
| `audit` | `/api/audit` | Denetim günlüğü, salt okunur: en yeni önce, `limit` (≤100), `cursor`, `from`/`to`, `action` öneki, `actorId`. Varsayılan kapsam JWT'deki apartman (`apartment_manager`, `management_company`, `observer`; `platform_admin` yalnızca destek oturumuyla); `?scope=platform` yalnızca doğrudan `platform_admin` (platform zinciri). Yanıt hash'e giren tüm alanları içerir (tarayıcıda doğrulama). `GET /integrity?scope=`: gece doğrulamasının durumu (`verified` / `pending` / `stale` / `empty`) |
| `mfa` | `/api/mfa` | `GET /users/:userId` (MFA ve hesap durumu, `canReset` / `blockedReason`; sıfırlamayla aynı yetki kuralları), `GET /users?email=` (yalnızca `platform_admin`), `POST /users/:userId/reset` `{ reason }` (10-500 karakter): cihaz kaybında TOTP'yi kapatır ve tüm oturumları düşürür; önce denetim günlüğüne yazılır. `platform_admin` herkes için; `apartment_manager` / `management_company` yalnızca kendi apartmanındaki, başka apartmanda yönetici/denetçi olmayan ve `platform_admin` olmayan kullanıcılar için. Kendi MFA'sı ve destek oturumu ile yapılamaz |
| `finance/bank` | `/api/bank` | Faz B3.5: `POST /statements/:id/commit` `{ …, rememberFormat? }` (eşleme `BANKFMT#` olarak aynı atomik yazımda + `bank.format.save`), `GET /lines/:lineId/payable-suggestions`, `POST /lines/:lineId/settle-payable` `{ bankAccountId, expectedVersion, payableAccountId, description?, reason? }`, `GET /reconciliation/report?bankAccountId=&from=&to=` (PDF, 5 dk imzalı link). Faz B3: `GET\|POST /statements/:id/auto-match` (`{ idempotencyKey, minConfidence? = 0.85 }`; istek başına 25 satır, `remaining > 0` ise aynı anahtarla devam), `POST /lines/:lineId/expense` `{ bankAccountId, expectedVersion, expenseAccountId, description?, supplier?, invoiceNumber?, reason? }`, `GET /reconciliation?bankAccountId=&from=&to=` (açılış/kapanış, fark, bekleyen net, açıklanamayan fark, giren/çıkan döküm); `/unmatch` gidere çevrilmiş satırı da ters kayıtla geri alır. Faz B2 eşleştirme: `GET /queue`, `/targets`, `/lines/:lineId/suggestions`, `/lines/:lineId/history`, `/reconciliation`, `/accounts`; `POST /lines/:lineId/match` `{ bankAccountId, expectedVersion, allocations[{accountId, amount}] }`, `/ignore`, `/unmatch` `{ bankAccountId, expectedVersion, reason }`; `PUT /accounts/:id/profile`. Faz B1 banka ekstresi aktarımı: `POST /statements/upload-url` (5 dk imzalı PUT, S3 `apartments/{apt}/bank-statements/{yyyy}/{mm}/{statementId}`, ≤ 5 MB), `POST /statements` (önizleme: CSV/XLSX/HTML-xls, sütun eşleme istek > hesaba kayıtlı > otomatik, dosya içi ve önceden aktarılmış tekrarlar, bakiye sürekliliği, çakışan dönem), `POST /statements/:id/commit` `{ expectedVersion, acknowledgeWarnings? }` (idempotent satır yazımı + denetim), `GET /statements[/:id]`, `GET /lines?bankAccountId=&status=&from=&to=&statementId=&order=&limit=&cursor=`, `GET\|PUT /formats/:bankAccountId` (sürüm koşullu), `GET /templates`. Yazma: `apartment_manager`, `management_company`; okuma: + `observer` (`platform_admin` yalnızca destek oturumuyla) |
| `support` | `/api/support/sessions` | Yalnızca `platform_admin`: gerekçeli (≥20 karakter) ve süreli (≤60 dk) destek oturumu aç/listele/bitir. Oturum `X-Support-Session: <apartmentId>.<sessionId>` başlığıyla o apartmanda **salt okunur** (`observer`) erişim verir; her istek işlenmeden önce denetime yazılır |

---

## Roller ve Yetkilendirme

Yedi rol: `platform_admin`, `management_company`, `apartment_manager`, `resident`, `building_staff`, `security_guard`, `observer` (salt-okunur).

- Apartman bazlı roller Cognito gruplarında değil, DynamoDB `Membership` kayıtlarında tutulur. Cognito grubu yalnızca `platform_admin` için kullanılır.
- Kullanıcı aktif apartmanı seçtiğinde **Pre Token Generation Lambda** access token'a `apartmentId`, `role` (ve varsa `organizationId`) claim'lerini ekler.
- Handler'lar tenant izolasyonunu istek gövdesinden değil, **JWT claim'lerinden** yapar.

---

## Güvenlik ve izleme

**Güncel durum**

- **Denetim günlüğü (G1):** Hassas işlemler aynı transaction'da ayrı ve yalnızca eklemeye açık bir tabloya yazılır. Her kayıt bir öncekinin SHA-256 özetine bağlıdır (apartman başına ve `PLATFORM` zinciri) ve 10 yıl saklanır. Zincirler her gece doğrulanır.
- **Zorunlu MFA (G2):** `platform_admin`, `management_company`, `apartment_manager` ve `observer` için TOTP zorunludur (`warn` → kullanıcı bazlı geçiş süresi → `enforce`). Zorunluyken API yalnızca `/api/me/*` uçlarını açar.
- **Platform erişimi:** `platform_admin` platform zincirini doğrudan görür. Apartman verisine yalnızca gerekçeli, en fazla 60 dakikalık, salt okunur ve her isteği denetlenen destek oturumuyla erişir.
- **Uç koruma (G3) bekliyor:** Alan adı alınınca Cloudflare WAF devreye girecek. Şimdilik stage ve rota bazlı throttling ile alarmlar kullanılıyor.

**Web ekranları**

| Rota | Kim | İçerik |
| --- | --- | --- |
| `/admin/audit` | `apartment_manager`, `management_company`, `observer` (kendi apartmanı), `platform_admin` (platform zinciri; apartman zinciri destek modunda) | Tarih, işlem ve aktör filtresi; "daha fazla yükle"; detay penceresi (gerekçe, maskeli IP/UA, ayrıntılar, `prevHash`/`hash`). Zincir göstergesi iki katmanlıdır: sunucunun gece doğrulaması (`/api/audit/integrity`) ve yüklenen her kaydın tarayıcıda (WebCrypto) SHA-256 ile yeniden hesaplanıp önceki kayda bağının kontrolü |
| `/admin/security` | `apartment_manager`, `management_company` | Apartmandaki kişiler ve görev rolleri; kişi başına 2FA durumu ve gerekçeli sıfırlama (sıfırlanamayan kullanıcıda nedeni gösterilir) |
| `/admin/users` | `platform_admin` | E-postayla kullanıcı arama, 2FA ve hesap durumu, gerekçeli sıfırlama (platform zincirine yazılır) |
| `/admin/apartments` → "Destek erişimi" | `platform_admin` | Gerekçe (≥20 karakter) ve süre (15/30/60 dk) ile oturum açma, apartmanın oturum geçmişi. Destek modunda istekler `X-Support-Session` başlığıyla gider ve arayüz denetçi rolüne geçer. Üstte geri sayımlı turuncu banner ve "Oturumu bitir" düğmesi görünür; süre dolunca veya API 401 dönünce mod kapanır, platform oturumu açık kalır. Mod sekme bazlıdır (`sessionStorage`) |
| `/mfa-setup` | Herkes (kapsamdaki rollerde zorunlu) | QR + manuel anahtar + 6 haneli kod ile TOTP kurulumu |

**Rota bazlı throttling** (`security_monitoring.tf`; hassas uçlar `ANY /api/{proxy+}` yerine kendi JWT rotalarından geçer)

| Rotalar | Hız / burst (varsayılan) | Değişkenler |
| --- | --- | --- |
| `POST /api/me/mfa/totp/setup`, `POST /api/me/mfa/totp/verify` | 1/sn, 5 | `mfa_route_rate_limit`, `mfa_route_burst_limit` |
| `POST /api/mfa/users/{userId}/reset`, `POST /api/support/sessions` | 1/sn, 3 | `security_admin_route_rate_limit`, `security_admin_route_burst_limit` |
| `POST /api/residents/invite`, `POST /api/finance/dues`, `POST /api/imports`, `POST /api/bank/statements/upload-url`, `POST /api/bank/statements`, `POST /api/bank/statements/{statementId}/commit`, `POST /api/bank/statements/{statementId}/auto-match`, `GET /api/bank/reconciliation/report` | 2/sn, 5 | `bulk_write_route_rate_limit`, `bulk_write_route_burst_limit` |
| Ödeme callback/webhook (kimliksiz) | 5/sn, 10 | `payments_callback_rate_limit` |
| Diğer tüm uçlar | 50/sn, 100 | `api_throttle_rate_limit`, `api_throttle_burst_limit` |

API Gateway sınırı istemci başına değil, rota başınadır: arka ucu ve maliyeti (Cognito, SES, toplu yazım) korur. Giriş (SRP) doğrudan Cognito'ya gider, API Gateway'den geçmez. LITE katmanında Cognito tehdit koruması yoktur; kaba kuvvet aşağıdaki alarmla izlenir.

**Güvenlik alarmları** (hepsi `alerts` SNS topic'ine, yani `alert_email`'e gider)

| Alarm | Kaynak | Koşul (varsayılan, değişken) | Ne yapılmalı |
| --- | --- | --- | --- |
| `<yığın>-signin-failures` | `AWS/Cognito` `SignInSuccesses`; başarısız = `SampleCount − Sum` (başarısız deneme 0 değerli veri noktası üretir) | 5 dk'da > 20 (`signin_failure_alarm_threshold`) | Kaba kuvvet veya credential stuffing olabilir. Cognito kullanıcı etkinliğine ve kaynak IP'lere bakın; gerekirse ilgili hesapları devre dışı bırakın |
| `<yığın>-mfa-verify-failed` | EMF `MfaVerifyFailed` (TOTP kurulumunda hatalı kod) | 5 dk'da > 10 (`mfa_verify_failure_alarm_threshold`) | API loglarında `msg=mfa_verify_failed`. Ele geçirilmiş oturumla kurulum denemesi olabilir |
| `<yığın>-mfa-reset-spike` | EMF `MfaReset` | 1 saatte > 3 (`mfa_reset_alarm_threshold`) | Denetim günlüğünde `mfa.reset` kayıtları (yapan, gerekçe). Yönetici hesabı ele geçirilmiş olabilir |
| `<yığın>-api-5xx` | `AWS/ApiGateway` `5xx` | 5 dk'da ≥ 5 (`api_5xx_alarm_threshold`) | API erişim logu (`status`, `integrationErr`) ve API Lambda logları |
| `<yığın>-audit-chain-broken` | EMF `AuditChainBroken` (gece denetimi) | > 0 | Scheduler-worker loglarında `msg=ledger_audit` / `audit_chain_*`. Kayıtlar değiştirilemez; inceleme yapılır, kontrol noktası bulgu giderilene kadar ilerlemez |
| `<yığın>-audit-run-missing` | EMF `AuditRun` (gece denetimi kalp atışı) | 24 saatte veri yok (`scheduler_enabled = false` iken kurulmaz) | Zamanlayıcı, görev kuyruğu/DLQ ve scheduler-worker logları |

`MfaRequiredDenied` (MFA'sız yetkili istek, `403 MFA_REQUIRED`) metriği yalnızca panelde izlenir; geçiş döneminin sonunda beklenen bir durumdur. Mevcut `LedgerDrift` alarmı zincir bulgularını da sayar.

---

## Finansal Kurallar

- **Append-only defter:** Hareketler güncellenmez veya silinmez; düzeltmeler ters kayıtla yapılır. Her kayıtta `createdAt`, `createdBy`, `reason` bulunur.
- **Kuruş cinsinden tam sayı:** Tüm tutarlar TRY kuruş olarak integer saklanır (1.500,50 TL → `150050`).
- **Kuruş dağıtımı:** Toplu tahakkukta artık kuruşlar en büyük kalan yöntemiyle, BigInt aritmetiğiyle dağıtılır.
- **Alt cari:** Rutin giderler oturana (kiracı, yoksa malik), demirbaş/yatırım giderleri malike yazılır.
- **Boş daire kuralı:** Tahakkuk tarihinde dairede kiracı veya oturan malik yoksa sakin gideri kat maliki carisine yazılır (işlem `vacant: true`, açıklamada "daire boş - kat malikine"). O gün hiç üyelik kaydı yoksa kural uygulanmaz ve önizlemede ayrıca raporlanır.
- **Taşınmada cari kapama:** Çıkış tarihine kadarki açık kalemler ve o güne kadar işlemiş tazminat tek atomik yazımla ayrılan sakin carisine (`recv-<daire>-<taraf>-c<kapama>`), malik carisine veya satışta yeni malike devredilir; avans iade edilebilir. Kaynak cari çıkış tarihine kadar kilitlenir (`closedThrough`), yeni sakin temiz bir cariyle başlar. Kapama ters kayıtla geri alınabilir.
- **Hisseli mülkiyet (Finans 2.1):** Pay kaynağı kesirdir (tapudaki gibi); mülkiyet sicilinde (`OWNERSHIP#<daire>#<geçerlilik>#<sıra>`, append-only) her kayıt toplamı **tam 1** olan pay tablosudur, `bps` yalnızca gösterimdir (en büyük kalanla toplam 10.000). Varsayılan `joint`: malik borcu tek ortak cariye yazılır. `split`: malik tahakkukları (boş daire kuralıyla malike düşenler dahil) tahakkuk tarihindeki paylarla paydaş alt carilerine (`recv-<daire>-owner-h<etiket>`) kuruş kaybı olmadan bölünür; portal, online ödeme, banka eşleştirmesi, gecikme tazminatı ve bildirimler paydaşa özeldir. Devir (tam satış / kısmi hisse / miras) sicil, üyelikler, gerekirse cari kapama ve denetimi tek atomik yazımda yapar; kısmi devirde geçmiş borç devredende kalır. Geri alma ters kayıtla.
- **Avans mahsubu ve borç yapılandırma (Finans 2.2):** Mahsup ve yapılandırma hedefli kapamayla (`settles`) yapılır; seçilmeyen kalemlerde FIFO değişmez. Farklı kişiler arası mahsup yalnızca muvafakat beyanıyla. Yapılandırmada o güne kadarki tazminat dondurulur, taksitlere yalnızca anapara payı (`feeBase`) üzerinden tazminat işler, vade farkı yoktur; muacceliyet plan eşikleriyle (varsayılan 2 ardışık / 3 toplam, 7 gün ek süre) tespit edilir, uygulama varsayılan olarak yönetici onaylıdır.
- **Mali dönem kapanışı (Finans 2.4):**
  - Kapanan ayın defteri kilitlenir: `FINLOCK.lockedThrough`.
  - Her defter yazımı (`postBatch`), en erken işlem tarihiyle kilide karşı `ConditionCheck` yapar. Kapalı döneme yazım `409 period_closed` döner.
  - Kapanış iki fazlıdır: kilit, ardından kilit altında aylık mizan anlık görüntüsü (`FPERIOD#<ay>`, tutar özeti `sha256`) ve doğrulama. Yarıda kalırsa devam eder.
  - Engeller: yarım sayaç onayı, inceleme bekleyen online ödeme, dengesiz mizan. Uyarılar (eşleşmemiş banka satırı, kesinleşmemiş tazminat, bekleyen mahsup, taslak sayaç dönemi) tek tek onaylanır.
  - Yıl sonu yalnızca snapshot'tır; deftere devir kaydı yazılmaz. Yalnızca son kapanan ay, gerekçe ve denetim kaydıyla yeniden açılır.
  - Raporlar kapalı ayları snapshot'tan, açık ayları tarih aralığı taramasıyla okur.
- **Bütçe / işletme projesi (Finans 2.4):**
  - Yıllık bütçe revizyonlarla tutulur (`BUDGET#<yıl>#v<n>`). Onay karar no ve tarihiyle yapılır; onaylı bütçe değişmez, yeni onay öncekinin yerini alır.
  - Bütçedeki aidat gelir satırı, toplu tahakkuk kurallarıyla daire başına önizlenir ve aylık aidat planına (`budgetId`, `incomeAccountId`) uygulanır.
  - Tahakkuklar seçilen gelir hesabına yazılır: aidat, demirbaş, ısınma.
- **Dağıtım anahtarları:** Eşit, m², arsa payı.
- **Atomiklik ve idempotency:** Çoklu kayıtlar `TransactWriteItems` ile yazılır; tekrar gelen istekler parmak izi + `attribute_not_exists` koşullu yazımla etkisiz kalır.
- **Defter denetimi:** Her gece `ledger_audit` hesap bakiyelerini `LE#` toplamlarıyla, işlem dengesini, kapama kilidini, makbuz sayacını ve tamamlanmış online ödemelerin defter kaydını karşılaştırır. Finans 2.4 ile kapalı her ayın snapshot'ını defterden yeniden hesaplar (`fiscal_period_drift`), kapanıştan sonra kapalı aya yazılmış işlemi (`fiscal_closed_write`), kilit/dönem tutarsızlığını ve 30 dakikadan uzun süren yarım kapanışı (`fiscal_lock_mismatch`) raporlar. Sapma otomatik düzeltilmez; yalnızca platform alarmı üretir (düzeltme ters kayıtla).
- **Online tahsilat komisyonu (sakine yansıtılmaz):** Sakin borcunun tamamını öder, ek ücret ödemez (5464 s. Kanun m.17). Komisyonu apartman öder: ödeme anında her kalemin alt üye işyeri payı = tutar − platform ücreti (varsayılan %0,75, aşağı yuvarlanır) − POS tahmini (sözleşme oranı yukarı yuvarlanır; sabit ücret işlem başına bir kez, ilk kalemde). Tahsilatla aynı `TransactWriteItems` içinde "Online Tahsilat Komisyon Gideri" (`exp-online-collection-fee`, referans `ONLINE-FEE:<niyet>`) yazılır; böylece `online-collection` bakiyesi apartmana aktarılacak tutara eşittir. Sağlayıcının gerçek komisyonu ve tahminle farkı niyetin `settlement` kaydına yazılır, apartman defterini değiştirmez. Payı komisyonu karşılamayan çok küçük tutar online ödenemez (400).
- **Transactional outbox:** Defter ve belge yazımından doğan olaylar (`DUE_GENERATED`, `PAYMENT_RECEIVED`, `LATE_FEE_POSTED`, `ANNOUNCEMENT_PUBLISHED`) doğrudan yayınlanmaz; aynı `TransactWriteItems` içinde `OUTBOX#<eventId>` kaydı olarak yazılır (`events/outbox.ts`). Yazım yoksa olay da yoktur; toplu tahakkukta her kalemin olayı kendi kaydıyla birlikte yazılır.

---

## Yol Haritası

### Tamamlanan

**Backend çekirdeği (Faz 1–5)**

- [x] DynamoDB yardımcıları, core modül (site, blok, bağımsız bölüm), JWT doğrulama
- [x] Çift taraflı, append-only defter; aidat tahakkuku, tahsilat, gider, ters kayıt, makbuz
- [x] Sakin portalı, SNS/EventBridge olay yayıncısı
- [x] Üyelik, duyuru ve apartman rol yönetimi
- [x] Serverless Terraform altyapısı, Lambda ESM build
- [x] CI pipeline, bildirim worker'ı, bootstrap betiği

**Web arayüzü (Faz 6–7)**

- [x] React + Vite iskeleti, Cognito girişi, apartman/rol bağlamı seçimi
- [x] Yönetici paneli: daireler ve sakin daveti, finans (tahakkuk, tahsilat, gider, hareketler, aidat durumu), duyurular, ayarlar
- [x] Sakin ekranları: ana sayfa, Borçlarım (özet kart + hesap ekstresi), duyurular

**Finans ve otomasyon**

- [x] Kıstelyevm gecikme tazminatı: ekranda canlı, deftere her ayın 1'inde kesinleşir; kısmi ödeme önce en eski anaparayı kapatır
- [x] EventBridge Scheduler: aylık tazminat kesinleştirme, aylık aidat planı ile otomatik tahakkuk, borç hatırlatmaları (vadeden 3 gün önce, 1 ve 7 gün sonra)
- [x] Blok kapsamlı ve daire muafiyetli toplu tahakkuk (önizlemeli)
- [x] S3 belge deposu + kısa ömürlü pre-signed URL: makbuz PDF'i, gider faturası yükleme
- [x] Excel/CSV toplu aktarım: daireler, kişiler, açılış bakiyeleri

**Dağıtım (Adım 8a)**

- [x] Web Cloudflare Pages'te canlı: https://building-management-apx.pages.dev (`dev` yığınına bağlı)
- [x] CI/CD: `main`'e push `dev` yığınını günceller; `prod` yalnızca `v*` etiketi veya elle tetiklemeyle
- [x] AWS bölgesi Terraform'da `eu-north-1` olarak sabit (hesap SCP'si diğer bölgeleri reddeder)

**Online ödeme — Adım 8b (`main`'e alındı: `2c89911`)**

- [x] Ödeme niyeti, ödenebilir tutar hesabı (toplam borç veya en eskiden başlayan seçili kalemler), ödeme anında tazminat kesinleştirme
- [x] Atomik tahsilat yazımı (`postBatch`): tazminat + tahsilat + makbuz + niyet durumu tek `TransactWriteItems`'ta
- [x] iyzico Checkout Form + Pazaryeri istemcisi: IYZWSv2 imzası, yanıt imzası, webhook V3 imzası, alt üye işyeri kaydı (`platform_admin`)
- [x] Callback, imzalı webhook ve 15 dakikalık mutabakat (`payment_reconcile`); şüpheli ödemeler `NEEDS_REVIEW` + alarm
- [x] Altyapı: iyzico anahtarları Secrets Manager'da, yalnızca iki kimliksiz rota (callback/webhook), `dev`'e uygulandı
- [x] Ortak dağıtım politikası modülü ve `github-deploy` kullanıcısına en az yetki
- [x] Web ekranları: sakin ödeme seçimi (`/app/odeme`) ve sonuç sayfası (`/app/odeme/sonuc`), yönetici Finans → "Online ödemeler" sekmesi, platform yöneticisi ödeme hesapları (`/admin/payments`)
- [x] `NEEDS_REVIEW` elle sonuçlandırma (yalnızca `platform_admin`): her kararda iyzico yeniden sorgulanır; deftere işle / tam iade (kalem bazlı `paymentTransactionId`) / kapat, zorunlu gerekçe ve denetim kaydı; çift iade koruması ve iadelerin 15 dakikalık mutabakatla tamamlanması, reddedilen iadede `PAYMENT_REFUND_FAILED` alarmı
- [x] Platform yöneticisi paneli apartmandan ayrıldı: yalnızca Apartmanlar (açılış, `GET /api/admin/apartments` dizini) ve Ödeme Hesapları; apartman ekranları platform rolüne kapalı
- [x] `github-deploy` kullanıcısından `AdministratorAccess` kaldırıldı; yalnızca en az yetkili `building-management-serverless-deploy` politikası, CI (PR planı + dev apply) ile doğrulandı
- [x] Dal `main`'e alındı (`2c89911`)

**Online Ödeme v2 — P1: komisyon ve pazaryeri onayı** (plan: proje belgesi `claude/online-odeme-v2-pazaryeri-plani.md`)

- [x] Ücret motoru (`payments/fees.ts`): platform ücreti %0,75 + POS sözleşme tahmini alt üye işyeri payından düşer; sakine ek ücret yok. Ortam varsayılanı + ödeme hesabı bazında geçersiz kılma (`PATCH .../account`, `null` ile sıfırlama, yanıtta `effectiveFees`)
- [x] Komisyon gideri tahsilatla aynı atomik yazımda; gecelik defter denetimi `ONLINE-FEE` kaydını ve tutarını kontrol eder
- [x] iyzico pazaryeri kalem onayı (`/payment/iyzipos/item/approve`): başarılı ödemeden hemen sonra; geçici hatada `payment_reconcile` 10 denemeye kadar yeniden dener, kalıcı hatada `PAYMENT_APPROVAL_FAILED` alarmı. Gerçek iyzico komisyonu (`iyziCommissionRateAmount + iyziCommissionFee`) mutabakat kaydına yazılır
- [x] Yönetici "Online ödemeler" listesinde komisyon, aktarılacak tutar ve onay durumu

**Online Ödeme v2 — P2: çoklu sağlayıcı soyutlaması**

- [x] Ortak `PaymentProvider` arayüzü: yetenekler (`checkout: redirect | iframe`, `settlement: item_approval | payout_transfer | automatic`), sağlayıcıya özgü tarayıcı dönüşü (`parseCallback`) ve webhook yanıtı (`webhookReply`), pazaryeri payının serbest bırakılması `releaseItem` (iyzico'da kalem onayı, PayTR'de P4 transferi)
- [x] Sağlayıcı kaydı ve çözümleyici (`payments/registry.ts`): `PAYMENTS_PROVIDERS` + `DEFAULT_PAYMENT_PROVIDER`; apartman tercihi (`PAYSETTINGS`) > ortam varsayılanı. Kapalı bir sağlayıcı tercih edilmişse online ödeme o apartman için kapalı; başka sağlayıcıya sessizce düşülmez
- [x] Devam eden niyetin tüm adımları (sorgu, callback, webhook, onay, iade, mutabakat) niyete yazılan sağlayıcıyla yürür; tercih değişse de ödeme kendi sağlayıcısında tamamlanır
- [x] Platform API'si: `GET/PUT /api/admin/payments/apartments/{id}/settings` (sürüm koşullu, denetim kaydı `payment.settings.update`); hesap uçlarında opsiyonel `provider`; apartman listesinde tercih ve etkin sağlayıcı
- [x] Altyapı ortam değişkenleri yeni adlara geçti (`PAYMENTS_PROVIDERS`, `DEFAULT_PAYMENT_PROVIDER`, `IYZICO_SECRET_ARN`); Terraform hâlâ tek sağlayıcı açar, PayTR secret'ı ve rotaları P3'te

**Online Ödeme v2 — P3: PayTR iFrame**

- [x] PayTR adaptörü (`payments/paytr/`): iFrame token (`/odeme/api/get-token`, `paytr_token` = base64 HMAC-SHA256, tek çekim `no_installment=1`, sepet base64 JSON, `timeout_limit` = niyet süresi), durum sorgusu (`/odeme/durum-sorgu`), sipariş bazlı kısmi/tam iade (`/odeme/iade`)
- [x] Sunucudan sunucuya bildirim (`POST /api/payments/paytr/webhook`, form): `merchant_oid + merchant_salt + status + total_amount` imzası sabit süreli karşılaştırılır, yanıt yalnızca düz metin `OK`; tekrar gelen bildirim idempotent. Niyet `merchant_oid` → `PAYREF#paytr#<oid>` eşleme kaydıyla bulunur (niyetle aynı atomik yazımda)
- [x] Başarı durum sorgusuyla doğrulanıp deftere yazılır (komisyon: `kesinti_tutari`). Durum sorgusu başarısızlığı raporlamadığı için başarısız bildirim niyeti hemen düşürmez; sayfa süresi dolunca `payment_reconcile` bildirimin koduyla FAILED yapar. FAILED sayılmış ödemeye geç gelen başarı `NEEDS_REVIEW` + alarm
- [x] Dönüş adresleri (`merchant_ok_url` / `merchant_fail_url`) API callback'ine (GET veya POST) gider, sonuç sorgulanıp `/app/odeme/sonuc?intent=…&result=ok|fail`'e yönlendirilir
- [x] Sakin arayüzü: `checkoutKind: iframe` yanıtında PayTR formu sayfaya gömülü açılır (yalnızca `https://www.paytr.com/odeme/guvenli/…` izinli); iframe içinde açılan sonuç sayfası kendini üst pencereye taşır; başarısız dönüşte sonuç hemen gösterilir
- [x] Altyapı: `payments_providers` + `default_payment_provider` + `paytr_test_mode`; sağlayıcı başına secret (`moved` ile mevcut iyzico secret'ı korunur), PayTR için `GET/POST …/paytr/callback` ve `POST …/paytr/webhook` kimliksiz rotaları (sıkı throttling), çıktılar `payments_secret_arns` / `payments_callback_urls`
**Online Ödeme v2 — P4: PayTR Platform Transfer, şifreli IBAN, komisyon faturası**

- [x] Aktarım alıcısı (IBAN + hesap sahibi adı) müşteri yönetimli KMS anahtarıyla şifreli (`payments/payee.ts`; şifreleme bağlamı apartman + sağlayıcı). TR IBAN mod-97 doğrulaması; yanıt ve loglarda yalnızca maskeli IBAN (`payeeOnFile`). API yalnızca şifreler; IBAN yalnızca transfer talimatı anında worker'da çözülür
- [x] PayTR Platform Transfer (`/odeme/platform/transfer`): onaydan `PAYTR_TRANSFER_DELAY_HOURS` sonra ve en erken ertesi gün, `payment_reconcile` içinde; deterministik `trans_id`; her talimat için aktarım kaydı (`PAYOUT#`, IBAN'sız). Transfer sonuç bildirimi (`POST /api/payments/paytr/transfer-webhook`, imzalı, düz metin `OK`) → `SETTLED`
- [x] Geri dönen aktarımlar: günlük `payout_returns` işi PayTR listesini (son 4 hane + tutar + talimat günü) aktarım kaydıyla eşler → `RETURNED` + kritik `PAYOUT_RETURNED` alarmı; eşleşmeyen kayıt `PAYOUT_RETURN_UNMATCHED`. Platform API'si: `GET /api/admin/payments/payouts`, `POST .../payouts/{transferId}/resend` (opsiyonel düzeltilmiş IBAN; hesap da güncellenir) → worker `/odeme/hesaptan-gonder` ile gönderir, sonuç bildirimi (`mode=cashout`) → `RESENT` / `RESEND_FAILED` (+ `PAYOUT_FAILED` alarmı)
- [x] Elle tetikleme: `POST .../intents/{intentId}/release` (bekleyen/başarısız aktarımı öne çeker; ertesi gün kuralı korunur)
- [x] Platform komisyon faturası altyapısı (`payments/invoices.ts`): sağlayıcıdan bağımsız `InvoiceProvider` arayüzü (`manual` varsayılan; Paraşüt/Foriba/BizimHesap adaptörü takılabilir), muhatap apartman yönetimi (VKN, `invoiceRecipient`), aylık veya ödeme bazlı taslak + mutabakat kaydı (`PINV#`), KDV hariç/dahil; aylık `platform_invoices` işi; kes / iptal uçları
- [x] Altyapı: KMS anahtarı + alias (yıllık döndürme), rol bazlı KMS izinleri, PayTR transfer sonuç rotası, `payout_returns` ve `platform_invoices` zamanlamaları, `PAYOUT_RETURNED` / `PAYOUT_FAILED` alarmları, dağıtım politikasına KMS yönetimi
**Online Ödeme v2 — P5: platform ekranları, KDV dahil fatura, canlıya geçiş runbook'u**

- [x] KDV kararı: `PLATFORM_INVOICE_VAT_MODE=inclusive` varsayılan (uygulama ve Terraform `platform_invoice_vat_mode`). Ödemede kesilen platform payı KDV dahil; fatura toplamı apartman defterindeki platform payı ile birebir aynı (ör. 9,99 TL → matrah 8,33 + KDV 1,66)
- [x] `GET /api/admin/payments/settlements?status=pending|failed&days=` (1-90, varsayılan 30): onay bekleyen / başarısız aktarımlar, tüm apartmanlar; IBAN veya şifreli alıcı dönmez
- [x] Web `/admin/payments`: hesap açarken tam IBAN + hesap sahibi adı ve sağlayıcı seçimi; "Ayarlar" diyaloğu (platform payı, POS oranı / sabit ücret — boş = ortam varsayılanı, IBAN değişikliği, fatura muhatabı VKN); kaydettikten sonra yalnızca maskeli IBAN; apartman bazında sağlayıcı (iyzico / PayTR / ortam varsayılanı, sürüm koşullu); satırda etkin sağlayıcı ve "IBAN kayıtlı değil" / "Fatura VKN eksik" rozetleri
- [x] Web `/admin/payments/transfers`: onay bekleyen/başarısız aktarımlar + "Şimdi tetikle" (gerekçeli); bankaya gönderilen aktarımlar bekliyor / tamamlandı / geri döndü / başarısız filtreleriyle; geri dönen ve başarısız aktarımı (isteğe bağlı düzeltilmiş IBAN ile) yeniden gönderme
- [x] Web `/admin/payments/invoices`: dönem seçimi, matrah/KDV/toplam özeti, VKN eksik uyarısı, taslağı yenile, dışarıda kesilen faturanın numarasıyla "Kesildi", taslak iptali

**Finans — taşınmada cari kapama ve borç devri (`main`'e alındı: `b162339`)**

- [x] Alt cari yorumlayıcısı: kesim tarihli cari, devir kalemleri vade ve tazminat başlangıcıyla taşınır; FIFO mahsup ve kıstelyevm tek kaynaktan (`subledger.ts`)
- [x] Kapama servisi ve API: önizleme, tek atomik yazım (tazminat kesinleştirme + devir/iade + kapama kaydı + üyelik bitişi), `closedThrough` kilidi, idempotency, güvenli geri alma
- [x] Ayrılan sakin carisinden tahsilat (`accountId`), ayrılan cariler raporu ve özet; ayrılan carinin tazminatı işlemeye devam eder; yeni sakinin portalı, makbuzları, online ödemesi ve bildirimleri eskisinden ayrı
- [x] Web: Daireler → "Taşınma" sihirbazı (kim/tarih → önizleme → borç & avans kararı → gerekçe/onay → yeni sakin daveti), kapama geçmişi ve "Geri al"; Finans → "Ayrılan cariler" sekmesi, tahsilatta cari seçimi ve "Tahsilat al" kısayolu
- [x] Boş daire kuralı: oturan yoksa sakin gideri kat malikine (tekil, toplu ve otomatik tahakkuk; önizleme ve bildirim dahil)
- [x] Kapamada ayrılan üyelik hemen pasifleşir, geri almada üyelikler geri yüklenir (`f793a55`)

**Güvenilir olay ve bildirim hattı (`main`'e alındı: `207b953`)**

- [x] Transactional outbox: domain olayları defter/belge yazımıyla aynı `TransactWriteItems`'ta `OUTBOX#` kaydı olarak yazılır; toplu tahakkukta kalem başına olay (yarıda kesilen istekte kayıp yok)
- [x] DynamoDB Streams → `outbox-relay` Lambda → SNS (yalnızca `OUTBOX#` INSERT filtresi, kısmi hata bildirimi, DLQ ve alarmlar); yerelde aynı çekirdekle bellek içi relay; API Lambda'sından `sns:Publish` kaldırıldı
- [x] `outbox_sweep` (5 dk): eşikten eski bekleyen olayları yeniden yayınlar (stream'in 24 saatini aşan kesintiler dahil)
- [x] `ledger_audit` (her gece 03:40, salt okunur): bakiye = Σ `LE#`, işlem dengesi, kapama kilidi, makbuz sayacı, online ödeme kayıtları; sapma → `LedgerDrift` metriği + platform alarmı, otomatik düzeltme yok
- [x] SES e-posta kanalı (`NOTIFICATION_CHANNEL=log|ses`), Türkçe HTML + düz metin şablonları (tek noktada escape), alıcı bazlı tekrar koruması, kalıcı/geçici SES hata ayrımı
- [x] Toplu tahakkukta kullanıcı başına tek özet e-posta (`DUES_BATCH_SUMMARY`), kullanıcı bildirim tercihleri (`/api/me/notification-preferences`, varsayılan açık)

**Güvenlik sertleştirmesi — G1 denetim günlüğü (`main`'e alındı: `0963eb6`)**

- [x] Ayrı denetim tablosu (10 yıl TTL, PITR): uygulama rolleri yalnızca `PutItem`/`GetItem`/`Query`; `UpdateItem`/`DeleteItem`/`BatchWriteItem`/PartiQL hem IAM'de hem tablo kaynak politikasında reddedilir
- [x] Apartman (ve kullanıcı geneli işlemler için `PLATFORM`) bazlı SHA-256 hash zinciri; her gece `ledger_audit` artımlı zincir doğrulaması (`AuditChainBroken` metriği)
- [x] Hassas işlemlerle aynı `TransactWriteItems`: defter, kapama/geri alma, üyelik ve rol, davet/kişi, site ayarları, online ödeme ve iade, toplu içe aktarma, bildirim tercihleri
- [x] KVKK: IP maskeli (IPv4 /24, IPv6 /48), User-Agent 200 karakter, ayrıntılarda e-posta/telefon/IBAN/kart maskeli
- [x] Salt okunur `/api/audit`; gerekçeli ve süreli `platform_admin` destek erişimi (`/api/support/sessions`)

**Güvenlik sertleştirmesi — G2 zorunlu MFA (`main`'e alındı: `0963eb6`)**

- [x] Kapsam: `platform_admin`, `management_company`, `apartment_manager`, `observer` (sakin, görevli, güvenlik isteğe bağlı); `mfa_enforcement_mode` (`off` / `warn` / `enforce`, varsayılan `warn`) ve kullanıcı bazlı `mfa_grace_period_days` (varsayılan 7)
- [x] Pre Token Lambda: kapsamdaki aktif rolde TOTP durumu (`AdminGetUser`), `mfa_enabled` / `mfa_grace_until` / `mfa_required` claim'leri; geçiş süresi ilk girişte `USER#<sub>`/`MFAGRACE` kaydıyla başlar
- [x] Tek merkezi API ara katmanı: zorunluyken `403 MFA_REQUIRED` (yalnızca `/api/me/*` açık), geçiş döneminde `X-MFA-Warning` başlığı; destek erişimi kararı `platform_admin`'in kendi token'ıyla
- [x] TOTP kurulum uçları (`/api/me/mfa`) ve denetimli yönetici sıfırlaması (`/api/mfa/users/:userId/reset`, `mfa.reset` / `mfa.totp.enable` denetim kayıtları)
- [x] Web: QR + manuel anahtar + 6 haneli kod ile kurulum ekranı (`/mfa-setup`), geçiş süresi banner'ı, `MFA_REQUIRED`'da kurulum ekranına yönlendirme

**Güvenlik arayüzü ve izleme (`feature/guvenlik-arayuz-izleme`)**

- [x] Denetim günlüğü ekranı (`/admin/audit`): filtre, sayfalama, detay, sunucu ve tarayıcı zincir doğrulaması; platform zinciri (`?scope=platform`) ve `GET /api/audit/integrity`
- [x] MFA yönetimi: apartman güvenlik ekranı (`/admin/security`), platform kullanıcı arama (`/admin/users`), `GET /api/mfa/users/:userId` ve `GET /api/mfa/users?email=`
- [x] Destek erişimi arayüzü: oturum açma/geçmiş, sekme bazlı destek modu (salt okunur, geri sayım, otomatik kapanma)
- [x] Hassas uçlarda rota bazlı throttling; giriş hatası, MFA, 5xx, zincir bozukluğu ve "gece denetimi çalışmadı" alarmları (EMF: `MfaVerifyFailed`, `MfaReset`, `MfaRequiredDenied`, `AuditRun`)

**Banka ekstresi aktarımı — Faz B1 (`main`'e alındı: `f717ce5`)** (modül: `apps/api/src/modules/finance/bank/`)

- [x] Bağımlılıksız dosya okuyucu: CSV (`;` `,` TAB `|` otomatik, RFC 4180 tırnakları, UTF-8 / Windows-1254), XLSX (ZIP + XML, ilk sayfa, sıkıştırma bombası sınırı) ve internet şubelerinin ".xls" adıyla verdiği HTML tablosu. Eski ikili Excel 97-2003 ve PDF açık mesajla reddedilir
- [x] Sütun eşleme: başlık satırı ilk 40 satırda otomatik bulunur (Türkçe karakter/noktalama duyarsız takma adlar); tutar modları `signed` / `debit_credit` / `amount_direction` (B/A). Hesaba kayıtlı eşleme `BANKFMT#<bankAccountId>` (sürüm koşullu, denetimli). Hazır banka şablonları (Ziraat, VakıfBank, Halkbank, İş, Garanti BBVA, Yapı Kredi, Akbank, QNB, DenizBank) takma ad kümesidir ve **gerçek ekstrelerle henüz doğrulanmadı** (`verified: false`)
- [x] Veri modeli: `BANKSTMT#<statementId>` (önizleme/aktarım özeti), `BANKFILE#<sha256>` (aynı dosya ikinci kez yüklenemez), `BANKTX#<bankAccountId>#<tarih>#<fp>` (banka hareketi; defter kaydı değildir, `status: unmatched`). Yeni GSI yok
- [x] Deterministik parmak izi (sha256: hesap, tarih, yön, tutar, işlem sonrası bakiye, referans, normalize açıklama): çakışan dönemli ekstrelerde aynı hareket tekrar yazılmaz. Bakiye ve referansı olmayan satırlarda gün içi sıra numarası (zayıf iz) ve çakışan dönem uyarısı
- [x] Bakiye sürekliliği (eskiden yeniye / yeniden eskiye otomatik), açılış/kapanış bakiyesi; okunamayan satır, bakiye tutarsızlığı veya zayıf iz + çakışmada aktarım için açık onay (`acknowledgeWarnings`)
- [x] Karşı taraf IBAN'ı: açıklama/sütundan ayıklanır, her yerde maskelenir; eşleştirme için yalnızca KMS HMAC özeti (`k1:`, apartman kapsamlı mesaj). Düz IBAN hiçbir kayda, yanıta veya denetim ayrıntısına yazılmaz
- [x] Aktarım: dosya yeniden okunup sha256 doğrulanır, aynı eşleme ile aynı satırlar üretilir; yalnızca olmayan satırlar `attribute_not_exists` ile yazılır (yarıda kalırsa tekrar çağrılabilir); ekstre `committed` + `bank.statement.commit` denetim kaydı
- [x] Altyapı: `bank.tf` (KMS `HMAC_256` + alias), API rolüne yalnızca bu anahtarla `kms:GenerateMac` (`kms:MacAlgorithm = HMAC_SHA_256`), banka yazma rotaları toplu yazım sınırında, dağıtım politikasında anahtar türü kısıtı (`SYMMETRIC_DEFAULT` / `HMAC_256`); plan testleri
- [ ] Dağıtım sırası: önce `infra/modules/deploy-policy` değişikliği yönetici kimliğiyle (`infra/github-deploy-user` ve/veya `infra/github-oidc`) uygulanır, sonra ana yığın

**Banka hareketi eşleştirme — Faz B2 (`main`'e alındı: `6831859`)**

- [x] Veri modeli: `BANKMATCH#<lineId>#<n>` (yalnızca eklenen karar kaydı: `match` / `unmatch` / `ignore` / `restore`; geri alma eski kaydı değiştirmez, `reverses` ile gösterir, `reversedBy` okumada türetilir), `PAYER#<ibanMac>` (öğrenilmiş gönderen, sürüm koşullu), `BANKREF#<kod>` + `BANKREFOF#<accountId>` (alt cari başına deterministik ödeme referans kodu, ör. `K7M2QA`), `BANKPROFILE#<bankAccountId>` (sakine gösterilen apartman IBAN'ı ve hesap sahibi). Yeni GSI yok
- [x] Öneri motoru (`bank/matching.ts`, saf): referans kodu 1.00 · öğrenilmiş gönderen 0.90 · blok/daire/villa kalıbı ("A-12", "A Blok 12", "Villa 12", "D:12") 0.60 (yalnız daire no 0.45) + Türkçe karakter normalize ad benzerliği +0.20 · tutar = açık bakiye veya aylık aidatın 1-12 katı +0.10; kapalı cari −0.30. Referans kodu dışındaki öneriler 0.95'i aşmaz. Çoklu kod / çoklu daire / çoklu cari IBAN'ında bölme önerisi
- [x] Eşleştirme (`POST /api/bank/lines/:lineId/match`): finans çekirdeğinin `postBatch`'iyle tek `TransactWriteItems` — valörde kesinleşen kıstelyevm tazminatı (tek `late_fee`), alt cari başına `payment` (`bank_transfer`, banka hesabına borç) + makbuz + `PAYMENT_RECEIVED` outbox, `BANKMATCH`, `BANKTX` (`matched`, sürüm +1), `PAYER` ve `bank.line.match` denetim kaydı. En fazla 10 alt cari, dağıtım toplamı = satır tutarı. Kapalı (`closedThrough`) cari: `409 account_closed` (`ledgerConflict: 'closed'`) + aynı dairenin ayrılan carileri; ayrılan cariye eşleştirme desteklenir
- [x] Yoksayma (`/ignore`, zorunlu gerekçe) ve geri alma (`/unmatch`): eşleşmiş satırda tahsilat ve tazminat tek atomik yazımda ters kayıtla iptal edilir, her işlem için `REV_` kaydı yazılır (makbuz "iptal", elle ikinci ters kayıt engellenir), gönderen sayacı azalır, satır yeniden `unmatched`; yoksayılmış satır yeniden açılır (`restore`)
- [x] Öneri sorgusu (`/lines/:lineId/suggestions`), eşleştirme kuyruğu (`/queue`, satır başına ilk öneri), cari arama (`/targets`; denetçiye adlar maskeli), karar geçmişi (`/lines/:lineId/history`), mutabakat özeti (`/reconciliation`: son ekstre kapanış bakiyesi, o tarihteki defter banka bakiyesi, fark, kuyruk özeti), banka hesapları ve sakin IBAN profili (`/accounts`, `PUT /accounts/:id/profile`; sakine tek hesap gösterilir)
- [x] Sakin portalı `GET /api/portal/my-payment-reference`: apartman IBAN'ı + hesap sahibi + sakinin görebildiği alt carilerin referans kodları (yoksa atomik oluşturulur)
- [x] Gece defter denetimi: `bank_match_mismatch` — eşleşmiş satırın karar kaydı, dağılım toplamı, bağlı tahsilat/tazminat işlemleri; geri alınan eşleştirmenin işlemlerinin iptal edilmiş olması. Eşzamanlı değişen satır "kararsız" sayılır
- [x] Web: Finans → "Banka" sekmesi (hesap seçici, mutabakat kartı, ekstre yükleme sihirbazı: dosya → sütun eşleme → önizleme ve uyarı onayı → içe al; eşleştirme kuyruğu: öneri + güven rozeti + gerekçe, tek tıkla "Onayla", "Eşleştir / Böl", "Yoksay", "Geri al"; bölme diyaloğunda cari arama ve kapalı caride ayrılan cari seçimi; hesap IBAN bilgileri). Sakin "Borçlarım": "Havale / EFT ile Öde" kartı (IBAN, hesap sahibi, referans kodu; tek tıkla kopyala)

**Finans 2.1 — Hisseli mülkiyet ve mülk/hisse devri (`main`'e alındı: `d83e07f`)**

- [x] Mülkiyet sicili (`OWNERSHIP#`, sicil başı `OWNERHEAD#`: sıra, faturalama modu, temsilci, sürüm), kesir aritmetiği (BigInt), tamlık (toplam tam 1), bps gösterimi; üyelik `ownershipShare` sicilin aynası. Üyeliklerden ilk sicil geçişi (`POST /api/ownership/backfill`; eksik hisseli bölümler atlanır ve `GET /issues`'ta raporlanır), elle sicil / hisse tamamlama
- [x] Daire bazında faturalama modu `joint` / `split`; `split` modda malik tahakkukları paydaş alt carilerine bölünür; gecikme tazminatı, aidat durumu, daire bakiyesi (`coOwners`), portal (paydaş yalnızca kendi carisi ve makbuzları), online ödeme (`accountId`), banka eşleştirmesi (paydaş carisi önerisi ve referans kodu) paydaş carisini tanır; tahakkuk / toplu özet / tazminat / hatırlatma bildirimleri paydaşa kendi tutarıyla gider
- [x] Mülk/hisse devri (tam satış, kısmi hisse, miras): önizleme + tek atomik yazım (sicil, üyelikler, cari kapama, `CARI_CLOSURE` + `ownershipTransferId`, denetim, idempotency); `joint`'te yalnızca tüm malikler çıkarsa ortak cari kapanır, `split`'te çıkan paydaşın carisi kapanır (`former` / `new_owner`); son devir ters kayıtla geri alınır
- [x] Oy ağırlığı hazırlığı: `GET /api/ownership/voting-roll` (sayıca 1 oy, arsa payı, temsilci; seçilmemişse “temsilci yok” uyarısı, varsayım yok)
- [x] Web: Daireler → **Mülkiyet** penceresi (paydaşlar, kesir ve %, toplam göstergesi, temsilci, faturalama modu, geçmiş, devirler ve geri alma), **Mülk / hisse devri** sihirbazı (tür, pay hareketleri, taslak tablo, önizleme, gerekçe ve onay), Finans → **Paydaşlar / hisse** (hisse tamlığı eksik daireler ve tamamlama, ilk sicil geçişi, paydaş carileri ve tahsilat), tahsilat diyaloğunda paydaş carisi seçimi, denetim etiketleri (`ownership.*`)
- [x] Testler: `apps/api/test/ownership.test.ts`; web `lib/ownership/shares.test.ts`, `pages/admin/units/ownershipWizard.test.ts`, `OwnershipTransferWizard.test.tsx`, `UnitOwnershipView.test.tsx`, `pages/admin/finance/ownershipPanel.test.ts`

**Finans 2.2 — Avans mahsubu ve borç yapılandırma (`feature/finance-offset-restructure`; backend doğrulandı, web yerel doğrulama bekliyor)**

- [x] Defter çekirdeği: alacak satırında hedefli kapama (`settles: [{ chargeId, amount }]`; hedefli tutar önce kendi kalemine, kalan havuz FIFO ile — seçilmeyen kalemlerin durumu değişmez), taksit kaleminde tazminat tabanı (`feeBase`; ödemeler önce anapara payını kapatır, taksitlendirilen tazminata tazminat işlemez). Yeni işlem türleri `offset` ve `restructure` (aynı alt caride kendi içinde dengeli, ara hesap yok). Gece denetimi `settlement_invalid`; genel ters kayıt ucu mahsup / plan işlemlerini ve bunlara bağlı kalemleri reddeder
- [x] Avans mahsubu (`OFFSET#`): serbest avans → başka alt carinin açık borcu, kısmi veya kalem seçerek, tek atomik yazım + denetim (`finance.offset`) + idempotency; kaynak sahipleri hedefte değilse "muvafakat alındı" beyanı + açıklama zorunlu ve denetimde işaretli; geri alma ters kayıtla. Sakin talebi (`OFFSETREQ#`): portaldan talep, yönetici kısmi tutar / muvafakatla onay veya gerekçeli ret
- [x] Borç yapılandırma (`PLAN#`): yapılandırma anına kadar işlemiş tazminat kesinleşip dondurulur (isteğe bağlı taksitlere dahil), seçilen kalemler hedefli kapanır, 1–60 aylık taksit kuruş kaybı olmadan açılır (`<işlem>_<n>`); vade farkı yok. Muaccel kılma, erken kapama (kalan taksitler bugüne), iptal (ters kayıt; dondurulan tazminat kalır). Ödenmemiş plan kalemi olan caride taşınma kapaması ve mülk/hisse devri `409`
- [x] Muacceliyet: plan bazında eşikler (varsayılan 2 ardışık veya 3 toplam geciken taksit, 7 gün ek süre). Günlük `installment_plans` işi (09:30 İstanbul, Terraform) temerrüdü tespit eder, sakine `DUES_REMINDER` / `plan_default` bildirimi plan yazımıyla aynı atomik outbox kaydında gider; plan `autoAccelerate` ise muaccel kılınır, değilse yönetici onayı beklenir
- [x] Web: Finans → **Avans mahsubu** diyaloğu (kaynak / hedef, serbest avans ve açık borç, tutar veya kalem seçimi, muvafakat, önizleme), **Borç yapılandır** sihirbazı (cari → kalemler + dondurulacak tazminat → taksit sayısı / ilk vade / muacceliyet eşikleri → kuruş kayıpsız önizleme → gerekçe), **Taksit planları** sekmesi (durum filtresi, çizelge, temerrüt uyarısı, muaccel kıl / erken kapama / iptal, bekleyen sakin mahsup talepleri onay/ret); daire cari penceresinde açık planlar ve kısayollar; sakin **Borçlarım**: “Taksit Planım” ve “Avans mahsubu talebi” kartları; denetim etiketleri (`finance.*`, `settlement_invalid`)
- [x] Testler: `apps/api/test/finance-2-2-core.test.ts`, `finance-2-2-offsets.test.ts`, `finance-2-2-plans.test.ts`; web `lib/restructure/model.test.ts`, `OffsetDialog.test.tsx`, `RestructureWizard.test.tsx`, `PlansPanel.test.tsx`, `components/portal/restructurePortal.test.tsx`

**Banka hareketi eşleştirme — Faz B3 (`main`'e alındı: `6ec959a`)**

- [x] Toplu otomatik onay: `GET /api/bank/statements/:id/auto-match` (ön izleme, yazım yok) ve `POST` (`{ idempotencyKey, minConfidence? }`, varsayılan eşik 0.85, alt sınır 0.60). Ekstre dönemindeki `unmatched` giren satırlardan en iyi önerisi eşiği geçen, ikinci önerisi en az 0.10 geride (çakışmasız) ve kapalı (`closedThrough`) cariye düşmeyenler, `match` ile aynı atomik yoldan işlenir (`source: 'auto'`, `autoRunId`). Görev kuyruğu yerine eşzamanlı ve sınırlı: istek başına en fazla 25 satır (API Gateway 29 sn), `remaining > 0` ise aynı anahtarla devam; yeni kuyruk/IAM gerekmez
- [x] Çalışma kaydı `BANKAUTO#<statementId>#<idempotencyKey>` (sürüm koşullu): aynı anahtarla eşzamanlı ikinci çağrı `409`, tamamlanmış çalışma tekrarında özet döner, farklı eşikle aynı anahtar `409`. Yarıda kesilmede (hata/zaman aşımı) yalnızca hâlâ eşleşmemiş satırlar işlenir. Sonuç: `matchedCount`, `totalMatchedAmount` (çalışma boyunca birikimli), `skippedLowConfidence`, `skippedAmbiguous`, `skippedClosed`, `skippedConflict`, `remaining`; denetim kaydı `bank.statement.auto_match` (her çağrıda)
- [x] Çıkan satırdan gider (`POST /api/bank/lines/:lineId/expense`): finans çekirdeğinin `postBatch`'iyle tek yazım — `EXPENSE` kaydı + `expense` işlemi (gider hesabı borç / ekstrenin banka hesabı alacak, valör tarihli, referans `BANK:<dekont>`), `BANKMATCH` (`kind: 'expense'`), `BANKTX` (`matched`, sürüm +1) ve `bank.line.expense` denetim kaydı. Banka ekstresi gerçekleşmiş ödeme olduğundan kasa/banka "yetersiz bakiye" kontrolü uygulanmaz. `/unmatch` gideri ters kayıtla iptal eder (`REV_` kaydı, satır yeniden `unmatched`)
- [x] Ayrıntılı mutabakat (`GET /api/bank/reconciliation?from&to`): aralıktaki ilk ekstrenin açılış ve son ekstrenin kapanış bakiyesi, kapanış günündeki defter banka bakiyesi, fark, bekleyen (eşleşmemiş) satırların net etkisi ve **açıklanamayan fark** (= fark − bekleyen net); eşleşen / bekleyen / yoksayılan satırların giren-çıkan dökümü. B2 alanları korunur
- [x] Gece denetimi: banka hesabı başına mutabakat (`bankRecon`) → EMF `BankReconDiff` (açıklanamayan farkın mutlak toplamı, kuruş) ve `BankReconAccountsOff`; `operations.tf` alarmı (günlük, eşik `bank_recon_diff_alarm_threshold`). `bank_match_mismatch` gider eşleştirmelerini de denetler
- [x] Altyapı: `POST /api/bank/statements/{statementId}/auto-match` toplu yazım throttling grubunda; plan testleri (rota, throttling, alarm, eşik doğrulaması)
- [x] Web: eşleştirme kuyruğunun üstünde ekstre + eşik seçimi ve **"Yüksek güvenli N satırı onayla"** (ön izleme listesiyle onay özeti, sonuç bildirimi; kalan satırlar için otomatik devam), çıkan satırlarda **"Gider Oluştur"** (açıklamadan gider kalemi tahmini, açıklama/tedarikçi/fatura no), ayrıntılı mutabakat kartı (tarih aralığı, açılış/kapanış, fark, açıklanamayan fark uyarısı, giren/çıkan döküm); denetim günlüğünde banka işlem etiketleri

**Banka — Faz B3.5 (`main`'e alındı: `6e2eb18`)**

- [x] Sütun eşlemesini hatırlama: aktarım isteğinde `rememberFormat: true` → ekstrenin `committed` geçişi ve hesaba kayıtlı eşleme (`BANKFMT#`, yeni veya sürüm koşullu) tek `TransactWriteItems`; zincirde ardışık iki denetim kaydı (`bank.statement.commit` + `bank.format.save`, `sendWithAudits`). Eşleme değişmediyse yeniden yazılmaz (`formatSaved: null`); kayıtlı eşleme bu arada değiştiyse `409` ve ekstre önizlemede kalır. Web sihirbazında eşleme kaynağı (kayıtlı / elle / otomatik) ve “Bu eşlemeyi hesap için hatırla” seçeneği
- [x] Tedarikçi borcu: yeni işlem türü `payable_payment` (borç: tedarikçi `payable` hesabı, alacak: kasa/banka). `GET /api/finance/payables` (açık borç = −bakiye; faturalar eskiden yeniye kapanır, ters kayıtla iptal edilenler sayılmaz), `POST /api/finance/payables/:accountId/payments` (elle; kasa/banka bakiyesi ve açık borç kontrolü, tedarikçi hesabı sürüm koşullu, idempotent). Açık borcu aşan ödeme reddedilir (avans mahsubu Finans aşamasında)
- [x] Bankadan tedarikçi ödemesi (`POST /api/bank/lines/:lineId/settle-payable`): `payable_payment` + `BANKMATCH` (`kind: 'payable'`) + `BANKTX` (`matched`) + `PAYEE#<ibanMac>` (öğrenilmiş alıcı IBAN'ı; tahsilat gönderen kaydından ayrı) + `bank.line.payable` denetimi tek yazım. `/unmatch` ters kayıtla geri alır; gece denetimi (`bank_match_mismatch`) bu eşleştirmeleri de kontrol eder
- [x] Öneri motoru (`suggestPayables`, yalnızca çıkan satırlar, toplu otomatik onaya dahil değil): öğrenilmiş alıcı IBAN'ı 0.85 / ad eşleşmesi 0.70 (kısmi 0.50) + tutar açık borca veya bir faturaya eşit +0.15 + fatura numarası açıklamada +0.10; tutar açık borcu aşıyorsa öneri yok
- [x] Dönemsel mutabakat PDF'i (`GET /api/bank/reconciliation/report`): saf `renderBankReconPdf` (`pdf-lib` + gömülü Noto Sans; A4, çok sayfalı; bakiye özeti, açıklanamayan fark, satır dökümü, bekleyen ve gerekçeli yoksayılan satırlar, imza alanı). `apartments/{apt}/reports/{yyyy}/{mm}/bank-recon-{hesap}-{başlangıç}-{bitiş}-{veriÖzeti}.pdf` olarak S3'te önbelleklenir (veri değişince yeni dosya), 5 dk imzalı indirme linki; denetçi dahil. Rota toplu yazım throttling grubunda
- [x] Web: kuyrukta çıkan satırlar için tedarikçi önerisi ve **“Tedarikçi Ödemesi”** diyaloğu (açık borç, açık fatura, kalan borç, fazla ödeme uyarısı), Finans → **Tedarikçiler** sekmesi (bakiyeler, açık faturalar, elle ödeme), mutabakat kartında **“PDF indir”**
- [x] Testler: `apps/api/test/bank-b3-5.test.ts`, web `lib/bank/payable.test.ts`, `lib/bank/formatMemory.test.ts`, `SettlePayableDialog.test.tsx`

**Finans 2.4 — Dönem kapanışı, bütçe, raporlar (`feature/finance-period-close-budget`)**

- [x] Hesap planı:
  - Hesap kodu (`Account.code`) ve hazır gelir hesapları: Demirbaş Gelirleri, Isınma / Yakıt Gelirleri.
  - Tahakkuk, aylık aidat planı ve sayaç şablonunda gelir hesabı seçimi.
  - Ayarlar kaydedilirken aidat planı gelir hesabı doğrulanır.
- [x] Dönem kilidi ve kapanış:
  - `FINLOCK` kilidi ve `postBatch` `ConditionCheck`.
  - Aylık snapshot, kontrol listesi, iki fazlı kapanış, gerekçeli yeniden açma.
  - Uçlar: `GET/POST /api/finance/periods…`.
- [x] Raporlar:
  - Mizan, gelir-gider, bütçe–gerçekleşen, kesin hesap, borçlu listesi, kasa/banka dökümü: `GET /api/finance/reports/<rapor>`.
  - `?format=pdf` ile sunucu tarafı PDF (S3 önbellek + 5 dk imzalı link).
  - `GET /api/finance/dashboard`.
- [x] Bütçe / işletme projesi: taslak, revizyon, karar referanslı onay, aidat önizlemesi ve aylık aidat planına uygulama (`/api/finance/budgets…`).
- [x] Web:
  - Finans → Raporlar, Bütçe, Dönem kapanışı sekmeleri.
  - Ayarlar → Hesap planı.
  - Genel Bakış göstergeleri ve 12 aylık gelir-gider grafiği.
- [x] Gece denetimi: dönem snapshot'ı, kapalı aya yazım ve kilit bütünlüğü. Taksit planı işlemleri hesap kapsamlı `LE#` okumasıyla okunur.

### Veri düzeltme betikleri

- `npm run fix:receivable-names -w @bm/api -- --dry-run` (Faz 1): adında ham daire kimliği olan eski alacak hesaplarını `Daire <no> - Kat Maliki / Kiracı/Sakin / Kat Maliki (paydaş)` biçimine çevirir. Yalnızca hesap adı (+ sürüm) değişir; defter ve geçmiş açıklamalar olduğu gibi kalır. Tekrar çalıştırılabilir, Scan yetkisi gerektirir (yönetici kimliği).

### Sırada

> iyzico sandbox Pazaryeri yetkisi ve ilk uçtan uca ödeme doğrulaması tüm modüller tamamlandıktan sonra yapılacak (bkz. [Canlıya Geçiş Kontrol Listesi](#canlıya-geçiş-kontrol-listesi)).

**Banka — sonraki adımlar**

- [ ] Büyük dönemler için mutabakat PDF'inin rapor worker'ına taşınması (Platform aşaması; renderer saf, taşınabilir), tedarikçi avans mahsubu (Finans aşaması)
- [ ] Faz B4 — canlı ödeme aktivasyonundan sonra: online tahsilatın banka hesabına aktarım mutabakatı (aşağıda)

**Ödeme ve tahsilatın devamı**

- [ ] Online tahsilatın banka hesabına aktarım mutabakatı: sağlayıcı ekstresi ↔ `PAYOUT#` kayıtları ↔ banka hareketi otomatik eşleştirme (B4; canlı ödeme sonrası. P4/P5'te aktarım takibi, geri dönüş ve elle yeniden gönderim hazır)
- [ ] Taksit, otomatik ödeme talimatı, şifresiz ödeme linki, iade

**Finans**

- [ ] Sayaç/endeks dağıtımı ve sayaç görselleri
- [ ] Finans 2.2 sonrası: sakin portalından yapılandırma talebi, tedarikçi avans mahsubu

**Platform ve operasyon**

- [ ] Eski soneksiz `building-management` (prod) yığını hakkında karar ve ilk `prod` sürümü
- [ ] Arıza/görev, ziyaretçi QR, anket/oylama, rezervasyon, ihale
- [ ] Yönetim firması portföyü, abonelik/lisans
- [ ] Cloudflare Pages Terraform modülü
- [ ] Rapor/PDF, banka ve OCR worker'ları
- [ ] Bildirim devamı: web'de tercih ekranı, yöneticiye toplu işlem özeti, SES geri dönüş/şikâyet olaylarının işlenmesi, SMS/WhatsApp kanalı

**Güvenlik sertleştirmesi (G3 alan adına bağlı, beklemede)**

- [ ] Denetim günlüğü devamı: S3 Object Lock (WORM) dışa aktarım
- [ ] MFA devamı: `warn` → `enforce` geçişinin ortam bazında planlanması
- [ ] G3 — Uç koruma (alan adı alındığında): API özel alan adı Cloudflare arkasında, WAF ve oran sınırlama, `disable_execute_api_endpoint`, kaynak doğrulama (HTTP API'ye AWS WAF bağlanamaz; CloudFront WAF'ı hesap SCP'si nedeniyle kullanılamaz)

### Online Ödeme Canlıya Geçiş Runbook'u (P1–P5)

Sıra önemlidir; her adım bir öncekinin çıktısını kullanır. Komutlar repo kökünden, ilgili ortamın tfvars dosyasıyla (`infra/dev.tfvars`, prod için ayrıca) çalıştırılır.

1. **Dağıtım politikası (yönetici kimliğiyle, bir kez).** KMS anahtarı, yeni zamanlamalar ve rotalar için CI kullanıcısının yetkisi önce genişletilir:
   ```bash
   terraform -chdir=infra/github-deploy-user init \
     -backend-config="bucket=building-management-tfstate-<hesap>-eu-north-1" \
     -backend-config="key=github-deploy-user/terraform.tfstate" \
     -backend-config="region=eu-north-1" -backend-config="use_lockfile=true"
   terraform -chdir=infra/github-deploy-user plan
   terraform -chdir=infra/github-deploy-user apply
   ```
   OIDC kullanılıyorsa aynı işlem `infra/github-oidc` için yapılır (ikisi de `infra/modules/deploy-policy` modülünü kullanır).
2. **tfvars.** Ödeme değişkenleri tanımlanır:
   ```hcl
   payments_providers         = ["iyzico", "paytr"]   # kullanılacak sağlayıcılar
   default_payment_provider   = "paytr"               # apartman tercihi yoksa
   paytr_test_mode            = true                  # canlıda false
   iyzico_base_url            = "https://sandbox-api.iyzipay.com"  # canlıda https://api.iyzipay.com
   payments_pos_rate_bps      = 249                   # sağlayıcı sözleşme oranı (%2,49)
   payments_pos_fixed_fee_kurus = 25                  # işlem başı sabit ücret (0,25 TL)
   paytr_transfer_delay_hours = 24
   platform_invoice_mode      = "monthly"
   platform_invoice_vat_mode  = "inclusive"           # varsayılan; kesilen pay KDV dahil
   alert_email                = "operasyon@ornek.com" # PAYOUT_RETURNED / PAYOUT_FAILED / PAYMENT_APPROVAL_FAILED alarmları
   ```
3. **Ana yığın.** `terraform -chdir=infra fmt -check`, `validate`, `test` (plan testleri), ardından `plan` / `apply` (CI'da `workflow_dispatch target=dev`). Apply sonrası:
   ```bash
   terraform -chdir=infra output payments_secret_arns
   terraform -chdir=infra output payments_callback_urls
   terraform -chdir=infra output payee_kms_key_arn
   ```
4. **Sağlayıcı sırları (Secrets Manager, konsoldan veya CLI ile; koda/tfvars'a yazılmaz).**
   - iyzico: `{"apiKey","secretKey"}`
   - PayTR: `{"merchantId","merchantKey","merchantSalt"}`
5. **Sağlayıcı paneli adresleri** (`payments_callback_urls` çıktısından):
   - iyzico → webhook: `iyzico.webhook`
   - PayTR Mağaza Paneli → Ayarlar → **Bildirim URL**: `paytr.webhook`
   - PayTR → **Platform Transfer Sonucu Bildirim URL**: `paytr.transfer_webhook`
6. **Alarmlar.** `alert_email` adresine gelen SNS abonelik onay e-postası onaylanır. Kritik alarmlar: `PAYOUT_RETURNED`, `PAYOUT_FAILED`, `PAYMENT_APPROVAL_FAILED`, `PAYOUT_RETURN_UNMATCHED`.
7. **Apartman hesapları (`/admin/payments`).** Her apartman için:
   - Gerekirse "Sağlayıcı" ile iyzico / PayTR / ortam varsayılanı seçilir.
   - "Ödeme hesabı aç": işyeri türü, KYC bilgileri, **tam IBAN + hesap sahibi adı** (KMS ile şifrelenir; sonra yalnızca maskeli görünür), platform payı (`0,75`).
   - "Ayarlar": POS oranı / sabit ücret (sözleşme farklıysa; boş = ortam varsayılanı), fatura muhatabı (unvan, **VKN**, vergi dairesi).
   - "Eksik bilgi" filtresinde hiçbir apartman kalmamalı (P4 öncesi açılmış PayTR hesaplarında IBAN + hesap sahibi bu diyalogdan girilir).
8. **Sandbox uçtan uca test** (test kartı, her sağlayıcı için):
   - Sakin portalından ödeme → sonuç sayfası `SUCCEEDED`, makbuz ve defter kaydı; apartman defterinde komisyon gideri = platform payı + POS tahmini.
   - Ertesi gün (veya `/admin/payments/transfers` → "Şimdi tetikle"): onay / PayTR transfer talimatı → aktarım kaydı `SENT` → sonuç bildirimi ile `SETTLED`.
   - Geri dönen aktarım simülasyonu (PayTR test ortamı elverirse) → `RETURNED` + alarm → düzeltilmiş IBAN ile "Yeniden gönder" → `RESENT`.
   - Ay başı (veya `POST .../invoices/draft`): `/admin/payments/invoices` taslağı; toplam = dönemdeki platform payları toplamı; e-Fatura/e-Arşiv'de kesilip numara girilir → "Kesildi".
   - P3/P4 kontrol listesindeki sağlayıcı yanıt biçimi varsayımları doğrulanır.
9. **Canlıya geçiş.** tfvars: `paytr_test_mode = false`, `iyzico_base_url = "https://api.iyzipay.com"`; sırlar canlı anahtarlarla güncellenir; sağlayıcı panellerinde canlı mağaza için 5. adımdaki adresler tekrar girilir; apply. İlk gerçek ödeme küçük tutarla yapılır ve 8. adımdaki zincir izlenir. Sandbox'ta açılan alt üye işyeri kayıtları canlıya taşınmaz: canlı sağlayıcıda hesaplar yeniden açılır.
10. **Geri dönüş (rollback).**
   - Tek apartman: `/admin/payments` → "Durdur" (yeni ödeme başlatılamaz; başlamış ödemeler tamamlanır) veya "Sağlayıcı" ile diğer sağlayıcıya geçiş.
   - Bir sağlayıcı: `payments_providers` listesinden çıkarılıp apply (o sağlayıcıyı kullanan apartmanlarda online ödeme kapalı görünür).
   - Tamamen: `payments_providers = []` ile apply; defter ve aktarım kayıtları korunur, bekleyen aktarımlar sağlayıcı paneli üzerinden elle tamamlanır.
   - Uygulama sürümü: önceki Lambda sürümüne CI ile yeniden dağıtım. Defter append-only olduğundan veri geri alınmaz; düzeltme ters kayıtla yapılır.

**Muhasebe notu (KDV dahil mod).** Ödemede apartman defterine tek gider yazılır: `exp-online-collection-fee` = platform payı + POS tahmini. Platform komisyon faturası yalnızca platform payını kapsar ve KDV dahildir (fatura toplamı = defterdeki platform payı). POS bölümünün faturası ödeme sağlayıcısı tarafından kesilir; tahmin ile gerçek komisyon farkı (`posFeeDrift`) platform marjı/kaybıdır, apartmana yansımaz.

### Canlıya Geçiş Kontrol Listesi

Bilinen, bilerek ertelenmiş adımlar:

- [ ] **AWS SES e-posta aktivasyonu (canlıya geçiş öncesi).** Alan adı henüz satın alınmadı; bildirimler şu an `notification_channel = "log"` modunda yalnızca yapılandırılmış log olarak üretiliyor, e-posta gönderilmiyor. Sıra:
  1. **Alan adı ve SES kimliği:** `yonetimsistemim.com` satın alındıktan sonra AWS SES'te (`eu-north-1`) alan adı kimliği (Domain Identity) oluşturulur. SES'in verdiği DKIM CNAME kayıtları ile SPF (TXT) ve önerilen DMARC (`_dmarc` TXT) kayıtları DNS'e eklenir; kimlik durumu *Verified* olana kadar beklenir.
  2. **Sandbox'tan çıkış:** SES konsolundan Production Access talebi açılır. Onaya kadar yalnızca doğrulanmış alıcılara gönderilebilir; diğer alıcılar `rejected` olarak atlanır (worker hata vermez).
  3. **Terraform değişkenleri:** İlgili ortamın tfvars dosyasında (`infra/dev.tfvars`, prod için ayrıca) `notification_channel = "ses"`, `notification_from_address = "YÖNESİST <bildirim@yonetimsistemim.com>"` (varsayılan; değişecekse burada) ve `web_app_url` (e-postalardaki portal bağlantıları, `https`) tanımlanır. Doğrulanmış kimliğin ARN'i `ses_identity_arn` olarak, Cognito'nun gönderen adresi `ses_from_address` olarak verilir (CI'da repo variable'ları `SES_IDENTITY_ARN` / `SES_FROM_ADDRESS`); `ses_identity_arn` verildiğinde Cognito da SES'e geçer ve `ses_from_address` zorunludur. Ardından plan/apply. Kimlik, gönderen adresin alan adını kapsamıyorsa plan ön koşul hatasıyla durur.
  4. **İsteğe bağlı:** Geri dönüş/şikâyet takibi için SES yapılandırma seti oluşturulup `ses_configuration_set` ile verilir.
  5. **Doğrulama:** Bir tahsilat girilip notification worker logunda `channel: "email"`, `sent: 1` görülür ve e-posta (HTML + düz metin, Türkçe karakterler, gönderen adı) kontrol edilir.

- [ ] iyzico Sandbox hesabındaki (Üye İşyeri No: `3438668`) Pazaryeri (Marketplace / SubMerchant) yetki başvurusu ve test kartıyla ilk uçtan uca online ödeme doğrulaması, projenin tüm modülleri tamamlandıktan sonra hayata geçirilecektir. Yetki açılana kadar alt üye işyeri kaydı `provider_rejected` döner; doğrulamada `paymentStatus` / `fraudStatus` eşlemeleri ve webhook imzası da kontrol edilecektir.
- [ ] **Online ödeme komisyonu (P1) canlıya geçiş öncesi:** Sağlayıcı sözleşme oranı tfvars'ta `payments_pos_rate_bps` / `payments_pos_fixed_fee_kurus` olarak tanımlanmalı (varsayılan `0`: POS maliyeti tahmin edilmez, platform payından karşılanır). P1'den önce açılmış ödeme hesaplarının platform ücreti `0` olabilir; `/admin/payments` veya `PATCH /api/admin/payments/apartments/{id}/account` ile `platformFeeBasisPoints: 75` yapılmalı. Sandbox doğrulamasında onay yanıtı ve `iyziCommissionRateAmount` / `iyziCommissionFee` alanlarının TL cinsinden geldiği varsayımı kontrol edilmeli.
- [ ] **PayTR (P3) canlıya geçiş öncesi:** `payments_providers`'a `paytr` eklenip apply edildikten sonra `terraform output payments_secret_arns` ile PayTR secret'ına `{"merchantId","merchantKey","merchantSalt"}` girilir; PayTR Mağaza Paneli → Ayarlar → **Bildirim URL** olarak `terraform output payments_callback_urls` → `paytr.webhook` tanımlanır. Mağaza test modundayken `paytr_test_mode = true`; canlıda `false`. Test kartıyla doğrulanacak varsayımlar: durum sorgusundaki `payment_amount` biçimi (`10,8` / `10.80`), `kesinti_tutari` alanı, `returns` dizisinin alan adları, dönüş adreslerine yapılan istek yöntemi (GET/POST), başarısız denemede bildirimin her denemede mi yoksa yalnızca sonunda mı geldiği. Pazaryeri payının aktarımı P4'e kadar elle (PayTR panelinden) yapılır.
- [ ] **P4 dağıtım sırası:** önce dağıtım politikası (`infra/github-deploy-user` ve/veya `infra/github-oidc`) uygulanmalı (KMS anahtarı yönetimi yetkisi), sonra ana yığın. Ana yığın sonrası PayTR Mağaza Paneli → Ayarlar → **Platform Transfer Sonucu Bildirim URL** = `terraform output payments_callback_urls` → `paytr.transfer_webhook`.
- [ ] **P4 mevcut hesaplar:** P4 öncesi açılmış ödeme hesaplarında tam IBAN saklanmadı (yalnızca maskeli). PayTR hesapları için `/admin/payments` → "Ayarlar" (veya `PATCH /api/admin/payments/apartments/{id}/account`) ile `iban` + `accountHolderName` girilmeli; girilmezse transfer `payee_missing` ile başarısız olur ve alarm üretir. Fatura muhatabı (VKN) yoksa `invoiceRecipient` girilmeli.
- [ ] **P4 sandbox doğrulaması:** Platform Transfer yanıtı (`reference`) ve aynı `trans_id` ile tekrar gönderimin davranışı; transfer sonuç bildiriminin yalnızca başarılı transferleri mi listelediği; geri dönen aktarım listesinin yanıt biçimi ve `transfer_date` alanı; `hesaptan-gonder` `trans_info.amount` biriminin kuruş olduğu varsayımı.
- [x] **Platform komisyonu KDV kararı (21.11.2026):** `PLATFORM_INVOICE_VAT_MODE=inclusive` varsayılan. Ödemede kesilen %0,75 KDV dahil sayılır; apartmandan ek KDV tahsil edilmez, fatura toplamı defterdeki platform payıyla birebir örtüşür.
- [ ] Aynı sandbox doğrulamasında iade akışı: Checkout Form sonucundaki `itemTransactions[].paymentTransactionId` alanı, `/payment/refund` yanıtı, raporlama servisinde (`GET /v2/reporting/payment/details`) başarılı iadenin `refundStatus = 1` olduğu varsayımı ve GET isteğinde sorgu dizgisinin IYZWSv2 imzasına katılmadığı varsayımı kontrol edilecektir.

---

## Lisans

Özel (private) proje. Tüm hakları saklıdır.
