# Building Management — Dijital Site ve Aidat Yönetim Sistemi

Türkiye'deki apartman, site ve profesyonel yönetim firmaları için çok kiracılı (multi-tenant), sunucusuz bir site ve aidat yönetim platformu. Kat Mülkiyeti Kanunu'na uygun alt cari (malik / kiracı) ayrımı, dağıtım anahtarlarıyla toplu tahakkuk ve değişmez (append-only) finansal defter üzerine kuruludur.

> **Durum (27.11.2026):** Aktif geliştirme; tüm işler `main` dalında. `dev` yığını AWS `eu-north-1`'de, web Cloudflare Pages'te (https://building-management-apx.pages.dev) çalışıyor. Tamamlananlar: backend çekirdeği, yönetici / sakin / görevli ekranları, kıstelyevm, belge deposu, toplu aktarım, online ödeme (iyzico + PayTR, P1–P5; **canlıya alınmadı**), taşınmada cari kapama, transactional outbox + bildirim hattı, güvenlik G1–G2 (SHA-256 zincirli denetim günlüğü, zorunlu MFA) ve arayüzü, banka ekstresi B1–B3.5, Finans 2.1–2.4 (hisseli mülkiyet, mahsup / yapılandırma, sayaç-endeks dağıtımı, dönem kapanışı / bütçe / raporlar), Faz 1 ekip-rol yönetimi, O1 arıza / bakım, Y1 anket / oylama ve genel kurul hazırlığı, kapı ve rezervasyon bildirimleri ile kategori bazlı bildirim tercihleri, büyük siteler için arka plan toplu işleri (`bulkjobs`, 5.000 bölüme kadar) ve prod yapılandırma şablonu (`infra/prod.tfvars`, korkuluklar). **Alan adı `yonetimsistemim.com` henüz satın alınmadı**; buna bağlı SES e-posta, G3 (Cloudflare WAF) ve canlı ödeme aktivasyonu planlanan / bekleyen adımlardır. `prod` yığını henüz dağıtılmadı ([infra/PROD_DEPLOY.md](infra/PROD_DEPLOY.md), [Canlıya Geçiş Kontrol Listesi](#canlıya-geçiş-kontrol-listesi)). Ayrıntılar için [Yol Haritası](#yol-haritası).

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
React (Vite; sayfa bazlı code-splitting)  ──►  API Gateway (HTTP API, JWT authorizer, throttling)
                                                   │
                                                   ▼
                                    API Lambda — Modüler Monolit (Hono)
                    ┌──────────────┬─────────────┼──────────────┬────────────────────┐
                    ▼              ▼             ▼              ▼                    ▼
               DynamoDB       Denetim tablosu  Cognito ◄── Pre Token Lambda    SQS bulk-jobs (+DLQ)
             (single-table,   (append-only,               (apartmentId / role /        │
              OUTBOX# kayıtları) SHA-256 zinciri)          MFA claim'leri)              ▼
                    │                                                         bulk-worker Lambda
                    ▼ DynamoDB Streams                                        (parçalı, kendini
              outbox-relay Lambda ──► SNS (olaylar) ──► SQS (+DLQ) ──►        yeniden kuyruğa atar)
                                                         Bildirim worker (log | SES)

EventBridge Scheduler ──► SQS scheduled-jobs (+DLQ) ──► scheduler-worker Lambda
  (aidat, gecikme tazminatı, hatırlatma, ödeme mutabakatı, bakım, gece defter + zincir denetimi)
```

| Katman | Teknoloji |
| --- | --- |
| Frontend | **YÖNESİST** markası (logo `apps/web/public/brand/`, `components/BrandMark.tsx`, renkler `styles/theme.css`); React 19 + Vite, Cloudflare Pages (Git entegrasyonu): https://building-management-apx.pages.dev (`dev` yığını). Sayfalar `React.lazy` ile ayrı parçalar (`router/lazyPage.tsx`), kütüphaneler vendor parçalarında (`vite.config.ts` → `rolldownOptions.output.codeSplitting`); Excel ve QR kütüphaneleri yalnızca ilgili ekranda dinamik yüklenir |
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
│   │   ├── scripts/              # seed-admin, backfill:sites, backfill:expense-index, backfill:finance-summary, backfill:month-summary, fix:receivable-names
│   │   └── test/                 # Vitest testleri
│   └── web/                      # @bm/web — React + Vite
├── infra/                        # Serverless Terraform yığını
│   ├── api.tf  cognito.tf  dynamodb.tf  sns_sqs.tf  worker.tf  outbox.tf  operations.tf
│   ├── scheduler.tf  bulk_jobs.tf  audit.tf  security_monitoring.tf  payments.tf  bank.tf  storage.tf
│   ├── environment.tf            # Alan adı bağlama + prod korkulukları (production_guardrails)
│   ├── dev.tfvars  prod.tfvars   # Ortam ayarları (gizli bilgi içermez)
│   ├── PROD_DEPLOY.md            # Prod dağıtım kontrol listesi
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
| `npm run build:lambda -w @bm/api` | `dist/lambda/` altına `api.mjs`, `pre-token.mjs`, `notification-worker.mjs`, `scheduler-worker.mjs`, `bulk-worker.mjs`, `outbox-relay.mjs` (esbuild, ESM) |
| `npm run backfill:expense-index -w @bm/api` | Gider tarih dizinini (GSI1) eski giderlere ekler; bkz. [Veri düzeltme betikleri](#veri-düzeltme-betikleri) |
| `npm run backfill:sites -w @bm/api` | Site dizinini (GSI1 `SITE_DIRECTORY`) eski sitelere ekler |
| `npm run backfill:finance-summary -w @bm/api` | Alt cari özetlerini (`FSUM#`) doldurur/tazeler; `--verify` eski tam-defter hesabıyla karşılaştırır; bkz. [Veri düzeltme betikleri](#veri-düzeltme-betikleri) |
| `npm run backfill:month-summary -w @bm/api` | Hesap-ay hareket özetinin (`MSUM#`) P1-c öncesi toplamlarını doldurur, defterle birebir doğrular ve siteyi hazır işaretler; `--dry-run`, `--verify`, `--site <id>` |
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
| `BULK_JOBS_QUEUE_URL` | Arka plan toplu iş kuyruğu (Terraform `bulk_jobs_queue_url`; API, scheduler-worker ve bulk-worker). Yerelde verilmezse iş aynı süreçte parça parça işlenir (inline kuyruk). |
| `BULK_JOB_BATCH_SIZE` / `BULK_JOB_CONCURRENCY` | bulk-worker: ilerleme kaydı başına bölüm (varsayılan 25) ve parça içi eşzamanlılık (varsayılan 4; sıcak gelir hesabı çakışmaları depoda kısa beklemeyle tekrar denenir). |
| `AUDIT_TABLE_NAME` | Denetim günlüğü tablosu (Terraform: `<proje>-<ortam>-audit`). Lambda'da tanımsızsa hassas yazımlar reddedilir (fail closed); yerel geliştirme ve testlerde tanımsızsa denetim atlanır. |

Gizli bilgiler koda gömülmez; AWS kimlik bilgileri SDK'nın varsayılan credential zincirinden gelir.

---

## Test

```bash
# API birim testleri (Vitest)
npm test -w @bm/api

# Web birim / bileşen testleri (Vitest + happy-dom) ve üretim derlemesi
npm test -w @bm/web
npm run build -w @bm/web

# Terraform plan testleri (AWS kimlik bilgisi gerektirmez, mock provider)
terraform -chdir=infra init -backend=false
terraform -chdir=infra test
```

Terraform testleri `command = plan` ile çalışır. Plan aşamasında bilinmesi gereken hesaplanmış değerler (ör. SQS ARN'i) `override_resource { override_during = plan }` ile sabitlenir.

Kapsam (27.11.2026): API 74, web 71 test dosyası; Terraform 36 plan senaryosu (prod korkulukları ve alan adı bağlama dahil). Yüksek hacim testi `apps/api/test/bulk-jobs-scale.test.ts`: 1.200 bağımsız bölümlü sitede toplu aidat ve sayaç onayı parça parça (continuation) tamamlanır; worker kesintisi, yinelenen / eşzamanlı mesaj ve yeniden denemede çift kayıt oluşmaz, kuruş mutabakatı ve mizan korunur.

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
| `environment.tf` | Alan adı bağlama (`custom_domain`, `web_subdomain` → CORS + `web_app_url`) ve prod korkulukları (`production_guardrails`: MFA `enforce`, `alert_email` zorunlu, yalnızca https CORS, silme koruması, zamanlayıcı açık, canlı ödeme kilidi). Ortam dosyaları: `dev.tfvars`, `prod.tfvars`; prod kontrol listesi `infra/PROD_DEPLOY.md` |
| `bulk_jobs.tf` | Arka plan toplu işleri: `bulk-jobs` kuyruğu + DLQ, `bulk-worker` Lambda, alarmlar |
| `bank.tf` | Faz B1: banka ekstresi karşı taraf IBAN HMAC anahtarı (`HMAC_256`, `GENERATE_VERIFY_MAC`) ve alias `<yığın>-bank-iban-hmac`. HMAC anahtarlarında otomatik döndürme yoktur; anahtar silinmemeli (eski özetler eşleşmez) |

Önemli değişkenler: `environment` (`prod` / `staging`), `alert_email`, `cors_allow_origins`, `cognito_user_pool_tier` (`LITE` / `ESSENTIALS`), `ses_identity_arn`, `ses_from_address`, `api_throttle_rate_limit`, `api_throttle_burst_limit`, `mfa_enforcement_mode`, `mfa_grace_period_days`; hassas rota sınırları ve güvenlik alarm eşikleri ([Güvenlik ve izleme](#güvenlik-ve-izleme)).

Elle dağıtım:

```bash
npm run build:lambda -w @bm/api
terraform -chdir=infra init -backend-config="bucket=<state-bucket>" -backend-config="key=serverless/terraform.tfstate" -backend-config="region=eu-central-1"
terraform -chdir=infra plan
terraform -chdir=infra apply
```

Çıktılar: `api_url`, `cognito_user_pool_id`, `cognito_user_pool_client_id`, `dynamodb_table_name`, `notification_queue_url`, `frontend_env`, `bulk_jobs_queue_url`, `cors_allow_origins`, `web_app_url` ve diğerleri.

### Prod ortamı (henüz dağıtılmadı)

- **`infra/prod.tfvars`:** `production_guardrails = true`, MFA `enforce`, açık kayıt kapalı, silme koruması ve zamanlayıcı açık, log saklama 90 gün, yalnızca `https` CORS, e-posta `log` kanalında (SES doğrulanana kadar), online ödeme **kapalı** (`disabled`, iyzico sandbox, PayTR test modu). `alert_email` / `ses_*` bilerek tfvars'ta yok: `-var-file` değerleri GitHub'dan gelen `TF_VAR_*` değerlerini ezerdi.
- **Alan adı (planlanan, henüz alınmadı):** `prod.tfvars`'ta `# custom_domain = "yonetimsistemim.com"` satırı yorumdadır. Alan adı alınıp Cloudflare Pages prod projesine `app.yonetimsistemim.com` bağlandığında bu satır açılır: adres CORS listesine eklenir ve `web_app_url` (ödeme dönüşü, e-posta bağlantıları) bu adres olur. SES bu satırla açılmaz (DNS doğrulaması ayrı adım).
- **`infra/environment.tf` korkulukları** (yalnızca `production_guardrails = true` iken, plan aşamasında): `environment = prod`, MFA `enforce`, `alert_email` dolu, CORS yalnızca `https` ve localhost'suz, `web_app_url` veya `custom_domain` var, silme koruması açık, zamanlayıcı açık, açık kayıt kapalı, `notification_channel = ses` ise `ses_identity_arn` var, canlı ödeme (iyzico `api.iyzipay.com` / PayTR `test_mode=false`) yalnızca alan adı ve komisyon oranıyla.
- **Kontrol listesi:** [`infra/PROD_DEPLOY.md`](infra/PROD_DEPLOY.md) — ilk dağıtım öncesi (eski soneksiz prod yığını kararı, `production` environment, `ALERT_EMAIL`, prod Pages projesi), dağıtım, SNS onayı, alan adı, SES ve ödeme sırası.

### Arka plan toplu işleri (`bulk_jobs.tf`)

Büyük toplu tahakkuk ve sayaç dönemi onayı HTTP isteğinde çalışmaz (API Gateway 30 sn / Lambda 15 sn):

| Kapsam | Davranış |
| --- | --- |
| ≤ 60 bağımsız bölüm (`SYNC_BULK_UNITS`, `SYNC_POSTING_UNITS`) | Senkron (eski davranış) |
| 61 – 5.000 bölüm (`MAX_BULK_UNITS`, `MAX_POSTING_UNITS`) | API iş kaydı (`BULKJOB#`) açar, SQS `bulk-jobs`'a mesaj bırakır ve **202** + `{ mode: 'job', job }` döner |

- **İşleme:** `bulk-worker` (300 sn, 1024 MB, en fazla 5 eşzamanlı) işi sürüm koşullu bir kirayla (`leaseUntil`) alır; bölümleri 25'erli alt parçalarla, parça içinde sınırlı eşzamanlılıkla yazar ve her alt parçadan sonra ilerlemeyi kaydeder. Lambda süresi 60 sn'nin altına düşünce veya çağrı başına 1.000 bölüme ulaşınca kirayı bırakır ve **kendini aynı kuyruğa devam mesajıyla bırakır** (self-chaining). Aidatta paylar ve borçlu taraf iş açılırken dondurulur (250'şerli `#L#` kayıtları); sayaçta dönemin `MDLINE` satırları kullanılır (hazırlık → parçalı yazım → sonlandırma).
- **Garantiler:** Kalem anahtarları senkron yolla aynıdır (`<key>_<unitId>`, `MDP_<periodId>_<unitId>`); SQS tekrar teslimi, yinelenen mesaj ve "Tekrar dene" çift kayıt üretmez. Geçici hata mesajı SQS'e geri bırakır (5 deneme → DLQ + alarm); aidatta iş mantığı hatası bölümü "hatalı" sayar, sayaçta işi `failed` yapar (dönem `posting` kalır, yeniden deneme kaldığı yerden sürer). Özet bildirim deterministik kimlikle tektir.
- **Zamanlayıcı:** Kuyruk tanımlıysa aylık otomatik aidat da bu iş olarak açılır (`auto-dues-<YYYY-MM>`).
- **Arayüz:** `BulkJobProgress` bileşeni `GET /api/jobs/:jobId`'yi 1,5 sn'de bir sorgular: "İşleniyor: 420 / 1.250 bölüm (%34)", bitince özet, hatalı bölümler ve "Tekrar dene". Pencere kapatılsa da iş sunucuda sürer.
- **Alarmlar:** DLQ boş değil, kuyrukta 15 dk'dan eski mesaj, worker hatası.

---

## CI/CD

`.github/workflows/serverless-deploy.yml`:

- **PR (`main`'e):** typecheck, test, `build:lambda` (paket kontrolü: `api`, `pre-token`, `notification-worker`, `scheduler-worker`, `bulk-worker`, `outbox-relay`), `terraform fmt` / `validate` / `test`; kimlik bilgisi varsa `dev`'e karşı salt okunur plan.
- **`main`'e push:** `dev` yığını (`infra/dev.tfvars`, state `serverless-dev/`) plan + apply + sağlık kontrolü (`dev` environment).
- **`v*` etiketi** (veya `main` / `v*` üzerinden `workflow_dispatch target=prod`): `prod` yığını (`infra/prod.tfvars`, state `serverless/`, `production` environment). Prod planı `production_guardrails` ile güvensiz ayarlarda başlamaz. Henüz hiç prod etiketi atılmadı.
- **Sağlık kontrolü:** `/api/health` yeni SHA'yı döner, korumalı uç 401 verir ve `terraform output cors_allow_origins` içindeki her `https` adresi için CORS ön kontrolü geçer.

Web (Cloudflare Pages, Git entegrasyonu): `main`'e her push'ta Cloudflare kendisi derler ve yayınlar. Derleme değişkenleri Pages proje ayarlarındadır (**Production** → prod yığınının `frontend_env` çıktısı, **Preview** → dev yığınının). CORS listesi ortamın tfvars dosyasındadır (`cors_allow_origins`; prod'da `custom_domain` açılınca `https://app.<alan adı>` otomatik eklenir). Prod için ayrı bir Cloudflare Pages projesi henüz oluşturulmadı (`prod.tfvars`'taki `pages.dev` adresi yer tutucudur).

AWS erişimi tercihen OIDC ile sağlanır (`infra/github-oidc`, repo variable `AWS_DEPLOY_ROLE_ARN`). Repo variable'ları: `AWS_REGION`, `ALERT_EMAIL` (prod'da zorunlu; boşsa prod planı korkulukta durur), `SES_IDENTITY_ARN`, `SES_FROM_ADDRESS`. Ortam ayarları (CORS, MFA, ödeme, alan adı, Cognito katmanı) `infra/dev.tfvars` ve `infra/prod.tfvars`'tadır; eski `CORS_ALLOW_ORIGINS` / `COGNITO_USER_POOL_TIER` değişkenleri artık kullanılmaz. Prod: `infra/PROD_DEPLOY.md`.

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
| `me` | `/api/me` | Oturum sahibinin seçebileceği apartman/rol bağlamları (`GET /contexts`); bildirim tercihleri (`GET\|PUT /notification-preferences`, `{ email: { enabled, finance?, announcements?, tickets?, gate?, reservations?, polls?, assemblies?, tenders? } }`, varsayılan hepsi açık; kategori `false` o konudaki e-postaları kapatır; PUT yalnızca gönderilen alanları okumadan yazar (`enabled` dahil isteğe bağlı, en az bir alan), diğerleri değişmez; ana anahtar kapalıysa hiçbiri gitmez); iki adımlı doğrulama (`GET /mfa`, `POST /mfa/totp/setup`, `POST /mfa/totp/verify`; kullanıcının Cognito access token'ı `X-Cognito-Access-Token` başlığında). **Rol claim'i gerektirmez**: bağlam seçilmeden önce ve MFA zorunluyken de çalışır |
| `core` | `/api/sites` | Site, blok ve bağımsız bölüm (daire/dükkan) yönetimi; m², arsa payı, sayaç kuralları |
| `finance` | `/api/finance` | Hesaplar, toplu aidat tahakkuku, tahsilat, gider, ters kayıt, bakiye; Faz B3.5 tedarikçi borcu: `GET /payables` (açık borç, faturalanan/ödenen, açık faturalar FIFO), `POST /payables/:accountId/payments` `{ idempotencyKey, fundsAccountId, amount, date?, description?, reference? }` (açık borcu aşan ödeme reddedilir); raporlar: `GET /summary`, `/dues-status` (FIFO gecikme), `/transactions` (sayfalı), `/former-accounts` (ayrılan sakin carileri). Taşınmada cari kapama: `GET /units/:unitId/closures/preview`, `GET\|POST /units/:unitId/closures`, `GET /closures/:closureId`, `POST /closures/:closureId/reverse`; Finans 2.2: `POST /offsets/preview`, `POST /offsets` `{ idempotencyKey, sourceAccountId, targetAccountId, amount, settles?, consent?, reason }`, `GET /offsets`, `POST /offsets/:id/reverse`, `GET /offset-requests`, `POST /offset-requests/:id/approve\|reject`, `GET /plans/open-items?accountId=`, `POST /plans/preview`, `POST /plans` `{ idempotencyKey, accountId, chargeIds, installments, firstDueDate, includeLateFees?, rule?, reason }`, `GET /plans`, `GET /plans/:id`, `POST /plans/:id/accelerate\|pull-forward\|cancel` |
| `memberships` | `/api/memberships` | Kullanıcı–daire bağlantıları (malik / kiracı); mülkiyet sicili olan bölümde hisse payı yalnızca devir veya sicil düzeltmesiyle değişir (409) |
| `ownership` | `/api/ownership` | Finans 2.1 hisseli mülkiyet: `GET /units/:unitId?date=` (pay tablosu kesir + bps, faturalama modu, temsilci, geçmiş), `PUT /units/:unitId/register` (elle sicil / hisse tamamlama), `PUT /units/:unitId/billing` `{ mode: joint\|split, reason, version }`, `PUT /units/:unitId/representative`, `POST /units/:unitId/transfers/preview`, `POST /units/:unitId/transfers` `{ idempotencyKey, kind: sale_full\|share_partial\|inheritance, effectiveDate, moves[{fromUserId,toUserId,share}], debtTo?: former\|new_owner, residents?, reason }`, `GET /units/:unitId/transfers`, `GET /transfers/:id`, `POST /transfers/:id/reverse`, `GET /issues`, `POST /backfill`, `GET /voting-roll?date=`. Yazma: `apartment_manager`, `management_company`; okuma: + `observer` |
| `residents` | `/api/residents` | Apartmanın kişileri (ad / e-posta, denetçiye maskeli) ve `POST /invite`: e-postayla Cognito kullanıcısı bul/oluştur + üyelik ata |
| `apartment-roles` | `/api/apartment-roles` | Apartman bazlı personel ve yönetici rolleri. Faz 1 (Ekip): `POST /invite` `{ email, fullName, role, startDate?, endDate? }` (Cognito kullanıcısını bulur/oluşturur; pasif kaydı yeniden etkinleştirir), `POST /:userId/:role/end` `{ version, reason, endDate? }` (gerekçe denetime yazılır), `POST /:userId/:role/resend-invite`. **Son yönetici koruması:** güncel `apartment_manager`/`management_company` kalmayacaksa bitirme, pasife alma ve bitişi öne çekme 409. Denetçi e-postaları maskeli görür. Web: `/admin/team`, `Hesabım` (`/admin/account`, `/app/account`) |
| `announcements` | `/api/announcements` | Duyuru oluşturma, onay, arşiv |
| `polls` | `/api/polls` | Y1 anket / oylama (yazma: `apartment_manager`, `management_company`; okuma: + `observer`): `GET /?status=draft\|scheduled\|open\|closed\|cancelled\|all`, `POST /` `{ title, description?, options[2-10], audience?: owners\|residents, weighting?: per_unit\|land_share, secret? = true, resultsVisibleBeforeClose? = false, opensAt?, closesAt }` (taslak), `GET\|PATCH /:id` (yalnızca taslak), `POST /:id/publish` `{ version }`, `POST /:id/close` `{ version, reason }` (erken kapatma), `POST /:id/cancel` `{ version }` (taslak), `GET /:id/results` (seçenek başına bölüm sayısı + arsa payı toplamı, katılım, kullanılan oyların salt çoğunluğu), `GET /:id/participation` (bölüm bazında katılım; gizli oylamada seçim yok). Denetim: `poll.publish`, `poll.close`, `poll.cancel`; yayında `POLL_PUBLISHED` outbox olayı |
| `assemblies` | `/api/assemblies` | Y1 kat malikleri kurulu (yazma: `apartment_manager`, `management_company`; okuma: + `observer`): `GET\|POST /` `{ kind: ordinary\|extraordinary, scheduledAt, location?, onlineUrl? (https), firstMeetingId? (ikinci toplantı), secondMeetingPlan? { scheduledAt, location?, onlineUrl? } (ilk toplantıda çağrıya yazılan ikinci toplantı, en az 7 en geç 15 gün sonra; ikinci toplantı kaydı da aynı aralıkta), agenda[1-30] { title, description?, decisionKind? (general\|operating_budget\|manager_election\|auditor_election\|beneficial_improvement\|common_area_change\|management_plan_change\|use_change\|central_heating_conversion\|major_disposition\|additional_floor\|custom), majority? (yalnızca custom: attendees\|persons_and_land\|four_fifths_persons\|four_fifths_votes\|four_fifths_persons_and_land\|two_thirds_votes\|unanimous) } }`, `GET /decision-book` (karar defteri PDF: apartmanın tüm kararları ve düzeltmeleri, toplantı tarihi sırasıyla; 5 dk imzalı link), `GET /:id` (toplantı + KMK m.30 yeter sayı + oy listesinden bölüm / malik / arsa payı / katılım satırları + karar kayıtları + toplantı başlamadan çağrı denetimi `callCheck` ve `callOutdated`), `PATCH /:id` (oy listesi dondurulmadan önce), `POST /:id/call` `{ version, resend?, reason? }` (çağrı e-postası: `ASMCALL#` alıcı kaydı + `ASSEMBLY_CALLED` outbox; olağanüstü toplantıda 15 günden az kaldıysa uyarı, engel değil; ikinci gönderim yalnızca `resend: true` + gerekçe), `PUT /:id/attendance/:unitId` `{ mode: present\|proxy\|absent, attendeeUserId?, proxyUserId? \| proxyName? }`, `POST /:id/quorum` `{ version }` (yeter sayıyı tutanağa geçir), `POST /:id/agenda/:itemId/tally` `{ version, yes, no, abstain }` (yalnızca katılanların oy çokluğu kuralında) veya `{ version, votes: { <unitId>: yes\|no\|abstain } }` (nitelikli çoğunlukta zorunlu; arsa payı eksikse arsa payı gereken karar 422), kayıtlı kararda yalnızca `correctionReason` ile düzeltme (yeni kayıt); ilk karardan sonra katılım 409, `PUT /:id/minutes` `{ version, chair?, clerks?[≤3], voteCounters?[≤3], notes?: { <itemId>: metin }, generalNotes? }`, `POST /:id/finalize` `{ version }` (tutanağı kesinleştir: `held`), `POST /:id/cancel` `{ version, reason }` (karar kaydı yoksa), `GET /:id/attendance-sheet` (hazirun cetveli PDF), `GET /:id/minutes` (toplantı tutanağı PDF; kesinleşmediyse taslak). Denetim: `assembly.create\|update\|cancel\|roll_freeze\|attendance\|quorum\|tally\|tally_correction\|call\|call_resend\|minutes\|finalize` |
| `portal/polls` | `/api/portal/polls` | Sakin: `GET /?unitId=` (dairemin görebildiği oylamalar, oy hakkı, kendi oyum), `GET /:id?unitId=` (sonuç: bittiyse veya açık oylamada ara sonuç açıksa), `POST /:id/vote?unitId=` `{ optionId }` (bölümün tek oyu; sonraki oy öncekinin yerine geçer) |
| `portal/assemblies` | `/api/portal/assemblies` | Sakin, yalnızca bugün apartmanda aktif **malik** üyeliği olan (`resident`; kiracı 403): `GET /` (çağrısı gönderilmiş veya tutanağı kesinleşmiş toplantılar; yaklaşanlar önce), `GET /:id` (tarih, yer / bağlantı, gündem ve gerekli çoğunluk, çağrı tarihi, ikinci toplantı; kesinleşince yeter sayı özeti ve kararlar: yalnızca toplam oy / bölüm / arsa payı oranı), `GET /:id/minutes` (kesinleşmiş tutanak PDF, 5 dk imzalı link). Başka maliklerin adı, bölüm bazında katılım ve oy yanıtta yok |
| `tickets` | `/api/tickets` | Faz 3 O1 arıza / talep (yönetim, görevli, güvenlik, denetçi): `GET /` (filtreler: `status`, `assignee=me\|none\|<id>`, `category`, `priority`, `unitId`, `blockId`, `overdue`, `q`, `from`/`to`, `cursor`), `GET /board` (durum sütunları + SLA özeti), `GET /assignees`, `POST /` `{ idempotencyKey, title, description, category, priority?, location, photos?, equipmentId? }` (ekipmanı yalnızca yönetim / görevli seçer), `GET\|PATCH /:id` (`equipmentId: null` bağlantıyı kaldırır; `equipmentId=` liste filtresi), `PUT /:id/estimate` `{ version, amount: kuruş \| null, note? }` (v2 görevli tahmini tutar notu: yönetim + talebin güncel görevlisi, atanmamışsa açan görevli; 0 dahil; bilgi amaçlı, deftere yazılmaz, iç olay `estimate_set` + denetim `ticket.estimate`; sakin ve güvenlik uçlarına `estimate` / `equipmentId` dönmez), `POST /:id/assign\|status\|comments`, `POST /photos/upload-url`, `GET /:id/photos/:photoId`, `GET /similar`. Masraf (O1-4; yönetim yazar, denetçi okur): `GET\|POST /:id/costs` (`mode: expense` yeni gider / `mode: link` var olan gider), `POST /:id/costs/:expenseId/unlink` `{ reason }`, `POST /:id/charges` `{ idempotencyKey, confirm: true, liableParty, amount, dueDate }` (daire içi talepte daireye yansıtma), `GET /costs/expense-options` |
| `portal/tickets` | `/api/portal/tickets` | Sakin: açtığım + dairemin talepleri (yalnızca herkese açık olaylar), `POST /` (öncelik seçilmez), `GET /similar`, `POST /:id/comments`, `POST /:id/confirm` `{ version, rating?, note? }`, `/reopen` `{ version, note }`, `/cancel` `{ version }`, fotoğraf yükleme / görüntüleme |
| `maintenance` | `/api/maintenance` | Periyodik bakım: `GET /presets`, `GET\|POST /templates` (v2: `equipmentId?`, görevlere kopyalanır), `GET\|PUT /templates/:id`, `POST /templates/:id/archive`, `GET /tasks` (`equipmentId=` filtresi), `GET /calendar?month=`, `GET /tasks/:id`, `POST /tasks/:id/assign\|start\|complete\|skip\|ticket` (görevden açılan arıza görevin ekipmanına bağlanır), `PUT /tasks/:id/estimate` `{ version, amount: kuruş \| null, note? }` (v2 görevli tahmini tutar notu; yönetim + görevin görevlisi), fotoğraflar; masraf uçları `/tasks/:id/costs` (talep ile aynı sözleşme). Görevler `maintenance_tasks` işiyle (04:10) idempotent üretilir; `ticket_maintenance` (07:30) çözülen talebi `autoCloseDays` sonra kapatır ve günlük operasyon özetini (`OPERATIONS_DIGEST`; v2: ekipman garanti / sözleşme / periyodik kontrol tarihleri yalnızca yönetime) yayınlar |
| `equipment` | `/api/equipment` | Arıza & bakım v2 ekipman sicili (yazma: `apartment_manager`, `management_company`; okuma: + `observer`, `building_staff`): `GET /` (filtreler: `q` ad / marka / model / seri no / konum, `category`, `status=active\|out_of_service\|retired\|all` (varsayılan hizmettekiler), `blockId`, `warrantyWithin=N` gün, `expiring=true`, `ids=a,b` (en fazla 100, durumdan bağımsız ad çözümleme); yanıtta `expiringCount` rozeti; görevliye `serviceCompany.supplierAccountId` dönmez), `GET /expiring?days=30` (30 gün içinde dolacak + tarihi geçen: garanti son 30 gün, servis sözleşmesi ve periyodik kontrol tümü; hizmetten çıkan hariç. Günlük özet bunların yalnızca son 30 günde dolanlarını taşır, tamamını pazartesi), `POST /` `{ name, category: elevator\|generator\|water_pump\|heating\|fire_system\|camera\|gate_barrier\|pool\|other, blockId?, location?, brand?, model?, serialNumber?, installDate?, warrantyEndDate?, serviceCompany?{ supplierAccountId? (Finans tedarikçi carisi), name?, phone?, email? }, serviceContractEndDate?, lastInspectionDate?, nextInspectionDate?, inspectionLabel?: green\|blue\|yellow\|red, notes? }`, `GET\|PUT /:id` (`version`; `null` alanı temizler), `POST /:id/status` `{ version, status, note? }` → `{ equipment, linkedTemplates, warning? }` (silme yok; `retired` gerekçeli, yeni bağlantı kabul etmez, bağlı aktif şablonlar döner), `GET /:id/history?years=5` (1–10; bağlı talepler ve bakım görevleri, Istanbul günü; yönetim / denetçiye ters kayıtlar düşülmüş yıl bazında masraf `costs.byYear`), belgeler: `POST /documents/upload-url` `{ fileName, contentType, size }` (PDF / görsel ≤ 10 MB, `tmp/{apt}/equipment-uploads/{userId}/…`), `POST /:id/documents` `{ version, uploadId, fileName, kind: warranty\|contract\|inspection\|manual\|other, title?, validUntil? }` (`apartments/{apt}/equipment/{equipmentId}/{documentId}.{ext}`), `POST /:id/documents/:docId/archive` `{ version }`, `GET /:id/documents/:docId` (5 dk imzalı link). Görevli masrafı ve servis sözleşmesi belgesini görmez. Denetim: `equipment.create\|update\|status\|document_add\|document_archive`. Talep (`POST\|PATCH /api/tickets`) ve bakım şablonu `equipmentId` taşır; kimlik JWT'deki apartman altında aranır (başka apartmanın ekipmanı 404) |
| `gate` | `/api/gate` | Güvenlik kapısı (yönetim + `security_guard`; denetçi ve bina görevlisi **403**): `GET /units?q=` (bölüm seçici, yalnızca etiket), `GET /plates?q=` (tam plaka veya son ≥ 3 karakter, tek `Query`, en fazla 10 sonuç: bölüm, kayıtlı / aktif, araç notu), `POST /passes/verify` `{ token }\|{ code }` (15 dk deneme sınırı, `GTHR#` sayaçları: kullanıcı sayacı her isteği 1, bulunamayan kısa kodu 6, bulunamayan QR jetonunu 2 puan sayar, sınır doğrulamada 60, plakada 120; önce kullanıcı sayacı, sınırı aşmış hesap apartman sayacına dokunmaz. Apartman sayacı yalnızca doğrulama başarısızlık cezalarını toplar (kısa kod 5, QR 1; sınır 150 = tüm görevlilerde 30 hatalı kod), başarılı okumalar saymaz; plakada apartman sınırı yok. Aşımda `429 rate_limited` + `Retry-After`, sınırı ilk aşan istek `gate.lockout` denetimi ve `GateLockout` metriği), `POST /passes/:id/entry\|exit` `{ idempotencyKey }` (geçerlilik dışı / iptal / kullanılmış: `409 pass_expired\|pass_not_yet_valid\|pass_revoked\|pass_used`), `GET\|POST /couriers`, `POST /couriers/:id/entry\|exit\|cancel` (kurye kaydı bölümde oturan sakinlere `GATE_COURIER_ARRIVED`, misafir girişi geçişi oluşturana `GATE_GUEST_ENTERED` e-postası; aynı atomik yazımda outbox), `POST /log` (elle giriş / çıkış), `GET /log?from&to&kind&unitId&cursor` (görevli: yalnızca dün + bugün). Yalnızca yönetim: `GET /units/:id/residents` (araç sahibi seçimi), `GET\|POST /vehicles` (`ownerUserId` zorunlu), `PATCH /vehicles/:id` `{ version, status?, note? }`, `GET /passes` (taşınmayla sistem iptalinde `revokeReason: taşınma`), `POST /passes/:id/revoke` (denetim: `gate.vehicle.*`, `gate.pass.revoke`; taşınma taraması `gate.departure_release`) |
| `portal/gate` | `/api/portal/gate` | Sakin (yalnızca **oturduğu** bölümler: kiracı veya dairede oturan malik): `GET /` (bölümler + sınırlar), `GET\|POST /vehicles`, `PATCH /vehicles/:id`, `GET\|POST /passes` `{ idempotencyKey, unitId, guestName, validFrom, validUntil?, entryMode: single\|multi, plate?, note? }`, `POST /passes/:id/revoke`, `GET /couriers`, `POST /couriers/:id/respond` `{ version, decision: approve\|decline, note? }`, `GET /log` (yalnızca kendi bölümü) |
| `reservations` | `/api/reservations`, `/api/portal/reservations` | Ortak alan rezervasyonu. Yönetim (yazma: `apartment_manager`, `management_company`; okuma: + `observer`): `GET\|POST /facilities` `{ idempotencyKey, name, description?, capacity, openingHours[{day,open,close}], slotMinutes (30/60/90/120/180/240), maxBookingMinutes (≤ 720), advanceDays, maxActivePerUnit, requiresApproval, cancelNoticeHours, blockIds?, feeKurus, incomeAccountId? }`, `PATCH /facilities/:id` `{ version, …, status?: active\|inactive }` (silme yok), `GET /bookings?facilityId=&from=&to=&status=` (Istanbul günleri, ≤ 62 gün), `GET /bookings/pending` (onay bekleyenler + iade bekleyenler `reversals`), `GET /bookings/:id`, `POST /bookings/:id/approve` `{ version, note? }`, `/reject` `{ version, reason }`, `/cancel` `{ version, reason }` (yarım kalan ücret iadesini de yeniden dener; iade hatası iptali bozmaz, `warning` döner; onay / ret / yönetim iptali rezervasyonu yapana `RESERVATION_*` e-postası), `/fee-resolved` `{ version, reason }` (Finans engelinde gerekçeli, denetimli elle çözüm). Sakin (`resident`): `GET /facilities` (blok kısıtı + dairelerim), `GET /facilities/:id/availability?date=` (dilimler `free\|busy\|mine\|past`; başka dairenin kimliği dönmez), `GET /bookings`, `POST /bookings` `{ idempotencyKey, facilityId, unitId, date, start: 'SS:DD', minutes, partySize?, note? }`, `POST /bookings/:id/cancel` `{ version }` |
| `tenders` | `/api/tenders`, `/api/portal/tenders` | İhale / teklif toplama. Yönetim (yazma: `apartment_manager`, `management_company`; okuma: + `observer`, denetçi yalnızca sakinlerle paylaşılmış ihaleleri görür): `GET /?status=`, `POST /` `{ idempotencyKey, title, description, category: mantolama\|asansor\|cati\|boya\|tesisat\|elektrik\|peyzaj\|other, deadline, minQuotes? (varsayılan 3), ticketId? }`, `GET\|PATCH /:id` (düzenleme yalnızca taslak / toplama), `POST /:id/collect` `{ version }`, `/publish` `{ version, shortfallReason? }` (her aktif teklifin belgesi şart; asgari sayı altında gerekçe zorunlu, sakinler görür), `/decide` `{ version, quoteId, reason, reference? }` (genel kurul / anket kararı serbest referans), `/cancel` `{ version, reason }`; teklifler `POST /:id/quotes` `{ idempotencyKey, supplierName, amountKurus, vatIncluded, vatRate, validUntil?, deliveryDays?, warrantyMonths?, notes?, document?: { uploadId, fileName } }`, `PATCH /:id/quotes/:quoteId` `{ version, … }`, `POST /:id/quotes/:quoteId/withdraw` `{ version, reason }`, `GET /:id/quotes/:quoteId/document` (5 dk imzalı link; `?history=<sıra>` yalnızca yönetim: değiştirilmiş önceki belge), `POST /:id/comments` (yönetim yanıtı, `tender.comment` denetimi; yanıtlanmamış soruların sahiplerine, her soru için bir kez, `TENDER_REPLIED` e-postası), `POST /:id/expense` `{ idempotencyKey, expenseAccountId?, creditAccountId?, amount?, date?, description?, supplier?, invoiceNumber?, invoiceUpload? }` (karara bağlanmış ihaleden Finans gideri: mevcut `recordExpense` servisiyle gider + defter + ihaledeki `expense` bağı + `ledger.expense` denetimi tek atomik yazım; verilmeyen tutar / firma / açıklama / gider kalemi karardan; ihale başına bir geçerli gider, aynı anahtar aynı sonuç, farklı anahtar 409; bağlı gider Finans'ta ters kaydedildiyse ayrıntı `expense.reversed` döner ve yeni anahtarla yenisi kaydedilebilir, eskisi `previousExpenses`'a geçer, denetimde `replacesExpenseId`). Ayrıntıda yönetime `expenseDraft` (ön dolum) veya `expense` (bağlı gider). Yayın, karar ve yayından sonra iptal `TENDER_PUBLISHED / _DECIDED / _CANCELLED` olaylarıyla apartmanın güncel üyelerine e-posta (aynı atomik yazımda outbox; payload yalnızca kimlik, worker güncel durumu okur ve bayat olayı atlar; tercih kategorisi `tenders`). Belge yükleme `POST /api/documents/invoice-uploads` (gider faturasıyla aynı sınırlar). Sakin (güncel üyeliği olan `resident`): `GET /`, `GET /:id` (teklifler KDV dahil normalize, karşılaştırma, sorular; sakin kimlikleri dönmez), `GET /:id/quotes/:quoteId/document`, `POST /:id/comments` `{ idempotencyKey, body }` (yalnızca yayındayken) |
| `portal` | `/api/portal` | Sakin ekranı: `my-unit`, `my-dues`, `my-statement`, `my-receipts`, duyurular; Finans 2.2: `my-plans`, `offset-options`, `GET\|POST offset-requests` |
| `metering` | `/api/metering` | Finans 2.3 sayaç / endeks dağıtımı (yazma: yönetici; okuma: + denetçi): sayaç sicili, değişim (`/swaps`, önizlemeli, geri alınabilir), dağıtım şablonları (hazır ısınma / su), dönemler, `POST /periods/:id/calculate` (önizleme + `calcHash`), `POST /periods/:id/approve` `{ calcHash }` (60 bölüme kadar senkron; üstü **202 + arka plan işi**), toplu ters kayıt ve düzeltilmiş dönem, daire dağıtım dökümü PDF, `GET /expenses` fatura seçicisi (gider tarih dizininden en yeni 200) |
| `meter-readings` | `/api/meter-readings` | Okuma girişi (yönetici + `building_staff`): açık dönemler, okuma cetveli, `PUT /periods/:id`, CSV/Excel toplu okuma (`/import`, `dryRun`), fotoğraf kanıtı (S3 imzalı URL) |
| `portal/meters` | `/api/portal/meters` | Sakin tüketim geçmişi (bina / blok ortalaması) ve dağıtım dökümü PDF |
| `imports` | `/api/imports` | Excel/CSV toplu aktarım (daireler, kişiler, açılış bakiyeleri): önizleme, 25'lik parçalarla idempotent yazım, hata raporu |
| `documents` | `/api/documents` | Makbuz PDF ve gider faturası: S3'e yalnızca kısa ömürlü imzalı URL ile yükleme / indirme |
| `payments` | `/api/finance/online-payments`, `/api/portal/payments`, `/api/admin/payments`, `/api/payments` | Online ödeme (iyzico + PayTR; **canlı değil**): yönetici listesi, sakin ödeme niyeti / sonuç, platform ödeme hesapları, ayarlar, aktarımlar, komisyon faturaları; kimliksiz callback / webhook rotaları |
| `audit` | `/api/audit` | Denetim günlüğü, salt okunur: en yeni önce, `limit` (≤100), `cursor`, `from`/`to`, `action` öneki, `actorId`. Varsayılan kapsam JWT'deki apartman (`apartment_manager`, `management_company`, `observer`; `platform_admin` yalnızca destek oturumuyla); `?scope=platform` yalnızca doğrudan `platform_admin` (platform zinciri). Yanıt hash'e giren tüm alanları içerir (tarayıcıda doğrulama). `GET /integrity?scope=`: gece doğrulamasının durumu (`verified` / `pending` / `stale` / `empty`). `POST /verify?scope=`: zinciri gece işini beklemeden artımlı doğrular (`apartment_manager`, `management_company`; platform zincirinde doğrudan `platform_admin`; gözlemci ve destek oturumu hariç; kontrol noktası 60 sn içinde tazeyse yeniden okunmaz). Bulguda kontrol noktası ilerlemez, ayrıntı yalnızca loga (`audit_chain_manual_verify`) yazılır |
| `mfa` | `/api/mfa` | `GET /users/:userId` (MFA ve hesap durumu, `canReset` / `blockedReason`; sıfırlamayla aynı yetki kuralları), `GET /users?email=` (yalnızca `platform_admin`), `POST /users/:userId/reset` `{ reason }` (10-500 karakter): cihaz kaybında TOTP'yi kapatır ve tüm oturumları düşürür; önce denetim günlüğüne yazılır. `platform_admin` herkes için; `apartment_manager` / `management_company` yalnızca kendi apartmanındaki, başka apartmanda yönetici/denetçi olmayan ve `platform_admin` olmayan kullanıcılar için. Kendi MFA'sı ve destek oturumu ile yapılamaz |
| `finance/bank` | `/api/bank` | Faz B3.5: `POST /statements/:id/commit` `{ …, rememberFormat? }` (eşleme `BANKFMT#` olarak aynı atomik yazımda + `bank.format.save`), `GET /lines/:lineId/payable-suggestions`, `POST /lines/:lineId/settle-payable` `{ bankAccountId, expectedVersion, payableAccountId, description?, reason? }`, `GET /reconciliation/report?bankAccountId=&from=&to=` (PDF, 5 dk imzalı link). Faz B3: `GET\|POST /statements/:id/auto-match` (`{ idempotencyKey, minConfidence? = 0.85 }`; istek başına 25 satır, `remaining > 0` ise aynı anahtarla devam), `POST /lines/:lineId/expense` `{ bankAccountId, expectedVersion, expenseAccountId, description?, supplier?, invoiceNumber?, reason? }`, `GET /reconciliation?bankAccountId=&from=&to=` (açılış/kapanış, fark, bekleyen net, açıklanamayan fark, giren/çıkan döküm); `/unmatch` gidere çevrilmiş satırı da ters kayıtla geri alır. Faz B2 eşleştirme: `GET /queue`, `/targets`, `/lines/:lineId/suggestions`, `/lines/:lineId/history`, `/reconciliation`, `/accounts`; `POST /lines/:lineId/match` `{ bankAccountId, expectedVersion, allocations[{accountId, amount}] }`, `/ignore`, `/unmatch` `{ bankAccountId, expectedVersion, reason }`; `PUT /accounts/:id/profile`. Faz B1 banka ekstresi aktarımı: `POST /statements/upload-url` (5 dk imzalı PUT, S3 `apartments/{apt}/bank-statements/{yyyy}/{mm}/{statementId}`, ≤ 5 MB), `POST /statements` (önizleme: CSV/XLSX/HTML-xls, sütun eşleme istek > hesaba kayıtlı > otomatik, dosya içi ve önceden aktarılmış tekrarlar, bakiye sürekliliği, çakışan dönem), `POST /statements/:id/commit` `{ expectedVersion, acknowledgeWarnings? }` (idempotent satır yazımı + denetim), `GET /statements[/:id]`, `GET /lines?bankAccountId=&status=&from=&to=&statementId=&order=&limit=&cursor=`, `GET\|PUT /formats/:bankAccountId` (sürüm koşullu), `GET /templates`. Yazma: `apartment_manager`, `management_company`; okuma: + `observer` (`platform_admin` yalnızca destek oturumuyla) |
| `bulkjobs` | `/api/jobs` | Arka plan toplu işleri (büyük siteler, 1.000–5.000 bölüm): `GET /:jobId` (durum `pending\|running\|completed\|completed_with_errors\|failed`, `processed` / `total` / `percent`, hatalı bölüm örnekleri, sonuç), `POST /:jobId/retry` (idempotent; yazılmış kalemler tekrar yazılmaz). Başlatan uçlar **202** + `{ mode: 'job', job }` döner: `POST /api/finance/dues/jobs` (her zaman), `POST /api/finance/dues` (toplu kapsam `SYNC_BULK_UNITS` = 60 bölümü aşarsa) ve `POST /api/metering/periods/:id/approve` (dönem `SYNC_POSTING_UNITS` = 60 bölümü aşarsa). İş SQS `bulk-jobs` kuyruğundan `bulk-worker` Lambda'sıyla 25'erli parçalarla, parça içinde sınırlı eşzamanlılıkla yazılır; Lambda süresi azalınca kendini aynı kuyruğa devam mesajıyla bırakır. Kalem anahtarları senkron yolla aynıdır (`<key>_<unitId>`, `MDP_<periodId>_<unitId>`): tekrar teslim ve yeniden deneme çift kayıt üretmez. Büyük sitelerde zamanlanmış aylık aidat da bu kuyruğu kullanır. Okuma: `apartment_manager`, `management_company`, `observer`; yeniden deneme: ilk ikisi |
| `support` | `/api/support/sessions` | Yalnızca `platform_admin`: gerekçeli (≥20 karakter) ve süreli (≤60 dk) destek oturumu aç/listele/bitir. Oturum `X-Support-Session: <apartmentId>.<sessionId>` başlığıyla o apartmanda **salt okunur** (`observer`) erişim verir; her istek işlenmeden önce denetime yazılır |
| `portfolio` | `/api/portfolio` | Yönetim firması portföyü (aktif rol `apartment_manager`, `management_company` veya `observer`; destek oturumu ve `platform_admin` **403**; zorunlu MFA merkezi ara katmandan): `GET /?limit=&cursor=` (varsayılan 12, en fazla 24 apartman) → `{ asOf, period, total, limit, items[], totals, nextCursor? }`. Apartmanlar token'daki tek `apartmentId`'den değil, kullanıcının **bugünkü** yetki kayıtlarından her istekte çıkarılır (GSI1 `USER#<sub>` + taban `APT#`/`ROLE#<user>#<role>` kaydının tutarlı BatchGet ile yeniden doğrulanması; apartman başına en yetkili rol). Kart başına yalnızca toplamlar (kişisel veri yok): daire sayısı, bu ay tahakkuk / tahsilat oranı (Genel Bakış `thisMonth` ile aynı hesap), vadesi geçmiş alacak ve gecikmedeki bölüm, kasa / banka, açık talep (önceliğe göre) ve SLA aşımı, geciken / 7 gün içindeki bakım, 30 gün içinde dolan ekipman son tarihleri, yaklaşan genel kurul, açık oylama, açık ihale (denetçi yalnızca paylaşılanları). Mevcut servislerin özetleri kullanılır (okumalar Query / GetItem / BatchGet; hazır hesap oluşturulmaz, tek yazım bayat `FSUM#` alt cari özetinin en iyi çaba geri yazılmasıdır); 4 apartman eşzamanlı (yuva, alttaki okuma bitene kadar dolu), apartman başına 5 sn; istek son tarihi Lambda'nın kalan süresi − 2,5 sn (API Lambda zaman aşımı 15 sn; Lambda dışında 10 sn). Okunamayan / süresi dolan bölüm yalnızca o kartta `failed` olur (`status: partial \| error`, hata ayrıntısı istemciye dönmez); son tarihe kadar başlamamış apartman okunmadan `error` döner. Yetki BatchGet'inde işlenemeyen anahtar üstel bekleme + jitter sonrası kalırsa **503** (sessizce düşürülmez). `Cache-Control: private, no-cache` + ETag (304) |

---

## Roller ve Yetkilendirme

Yedi rol: `platform_admin`, `management_company`, `apartment_manager`, `resident`, `building_staff`, `security_guard`, `observer` (salt-okunur).

- Apartman bazlı roller Cognito gruplarında değil, DynamoDB `Membership` kayıtlarında tutulur. Cognito grubu yalnızca `platform_admin` için kullanılır.
- Kullanıcı aktif apartmanı seçtiğinde **Pre Token Generation Lambda** access token'a `apartmentId`, `role` (ve varsa `organizationId`) claim'lerini ekler.
- Handler'lar tenant izolasyonunu istek gövdesinden değil, **JWT claim'lerinden** yapar.
- Web menüsü ve rota korumaları aynı rol listelerini kullanır (`apps/web/src/types/roles.ts`, `layouts/adminNav.ts`, `router/index.tsx`). Menüde görünmeyen bir ekrana doğrudan URL ile girilirse kullanıcı rolünün açılış sayfasına yönlendirilir; yetkinin asıl kaynağı yine API'dir.

| Yönetim paneli ekranı | `apartment_manager` | `management_company` | `observer` | `building_staff` | `security_guard` | `platform_admin` |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| Portföy (`/admin/portfolio`; menüde yalnızca bu rollerden biriyle **en az iki apartmanı** olana) | ✓ | ✓ | ✓ (yalnızca denetçi olduğu apartmanlar, salt okur) | — | — | — (destek oturumunda da yok) |
| Genel Bakış (`/admin`) | ✓ | ✓ | ✓ (salt okur) | ✓ (bekleyen işler) | ✓ | — (platform paneli) |
| Daireler, Finans, Duyurular, Oylamalar (`/admin/polls`), Genel Kurul (`/admin/assemblies`), Toplu Aktarım, Ayarlar (`OFFICE_ROLES`) | ✓ | ✓ | ✓ (salt okur) | — | — | — |
| Sayaç Dağıtımı (`/admin/meters`) | ✓ | ✓ | ✓ (salt okur) | — | — | — |
| Sayaç Okuma (`/admin/meter-readings`) | ✓ | ✓ | — | ✓ | — | — |
| Arıza & Bakım (`/admin/tickets`) | ✓ | ✓ | ✓ (salt okur) | ✓ | ✓ (kendi talepleri) | — |
| Ekipman (`/admin/equipment`) | ✓ | ✓ | ✓ (salt okur) | ✓ (salt okur; masraf ve servis sözleşmesi yok) | — | — |
| İşlerim (`/admin/my-tasks`) | — | — | — | ✓ | — | — |
| Güvenlik Kapısı (`/admin/gate`) | ✓ (+ araçlar, misafir geçişleri, tüm günlük) | ✓ | — | — | ✓ (QR / kod, plaka, kurye, dün + bugün) | — |
| İhaleler (`/admin/tenders`) | ✓ | ✓ | ✓ (yalnızca paylaşılanlar, salt okur) | — | — | — |
| Ekip (`/admin/team`) | ✓ | ✓ | ✓ (salt okur) | — | — | — |
| Denetim Günlüğü (`/admin/audit`) | ✓ | ✓ | ✓ | — | — | ✓ (platform zinciri) |
| Güvenlik / MFA sıfırlama (`/admin/security`) | ✓ | ✓ | — | — | — | — |
| Apartmanlar, Ödeme Hesapları, Aktarımlar, Faturalar, Kullanıcılar | — | — | — | — | — | ✓ |

`resident` yalnızca sakin portalını (`/app/*`; misafir / kurye / araç: `/app/ziyaretci`; paylaşılmış ihaleler: `/app/ihale`; genel kurul yalnızca kat maliklerine: `/app/genel-kurul`) görür; üst çubukta aktif sitenin adı (yoksa **YÖNESİST** markası) gösterilir.

---

## Güvenlik ve izleme

**Güncel durum**

- **Denetim günlüğü (G1):** Hassas işlemler aynı transaction'da ayrı ve yalnızca eklemeye açık bir tabloya yazılır. Her kayıt bir öncekinin SHA-256 özetine bağlıdır (apartman başına ve `PLATFORM` zinciri) ve 10 yıl saklanır. Zincirler her gece doğrulanır.
- **Denetim günlüğü arayüzü:** Olaylar Türkçe etiketlenir (defter, arıza talebi `ticket.*`, bakım `maintenance.*`, sayaç `meters.*`, finans dönemi / bütçe vb.); sözlükte olmayan anahtar okunabilir yedek etiketle gösterilir. Gece doğrulaması gecikirse yönetici **"Zinciri şimdi doğrula"** (`POST /api/audit/verify`) ile artımlı doğrulama yapabilir. Gece işinde zincir doğrulaması defter denetiminden bağımsız çalışır: biri hata verse de diğerinin kontrol noktası ve metriği üretilir (`audit_chain_verify_failed` logu).
- **Zorunlu MFA (G2):** `platform_admin`, `management_company`, `apartment_manager` ve `observer` için TOTP zorunludur (`off` / `warn` → kullanıcı bazlı geçiş süresi / `enforce`). Zorunluyken API yalnızca `/api/me/*` uçlarını açar. `dev` varsayılanı `warn`; `prod.tfvars`'ta `enforce` ve prod korkuluğu başka bir değere izin vermez.
- **Platform erişimi:** `platform_admin` platform zincirini doğrudan görür. Apartman verisine yalnızca gerekçeli, en fazla 60 dakikalık, salt okunur ve her isteği denetlenen destek oturumuyla erişir.
- **Uç koruma (G3) bekliyor:** Alan adı (`yonetimsistemim.com`) henüz satın alınmadı; alındığında Cloudflare WAF devreye girecek. Şimdilik stage ve rota bazlı throttling ile alarmlar kullanılıyor.
- **Alarm teslimi:** Tüm alarmlar `alerts` SNS topic'ine gider; e-posta aboneliği yalnızca `alert_email` (GitHub `ALERT_EMAIL`) doluysa oluşur ve ilk apply'dan sonra gelen SNS onay e-postası tıklanana kadar **hiçbir alarm iletilmez**. Prod korkuluğu boş `alert_email`'i reddeder.

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
| `POST /api/gate/passes/verify`, `GET /api/gate/plates` (platform geneli kova: arka uç kapasitesine göre yüksek; istemci başına sınır uygulamadaki kullanıcı / apartman sayacıdır, ileride Cloudflare ile IP başına) | 100/sn, 200 | `gate_route_rate_limit`, `gate_route_burst_limit` |
| Ödeme callback/webhook (kimliksiz) | 5/sn, 10 | `payments_callback_rate_limit` |
| Diğer tüm uçlar | 50/sn, 100 | `api_throttle_rate_limit`, `api_throttle_burst_limit` |

API Gateway sınırı istemci başına değil, rota başınadır: arka ucu ve maliyeti (Cognito, SES, toplu yazım) korur. Giriş (SRP) doğrudan Cognito'ya gider, API Gateway'den geçmez. LITE katmanında Cognito tehdit koruması yoktur; kaba kuvvet aşağıdaki alarmla izlenir.

**Güvenlik alarmları** (hepsi `alerts` SNS topic'ine, yani `alert_email`'e gider)

| Alarm | Kaynak | Koşul (varsayılan, değişken) | Ne yapılmalı |
| --- | --- | --- | --- |
| `<yığın>-signin-failures` | `AWS/Cognito` `SignInSuccesses`; başarısız = `SampleCount − Sum` (başarısız deneme 0 değerli veri noktası üretir) | 5 dk'da > 20 (`signin_failure_alarm_threshold`) | Kaba kuvvet veya credential stuffing olabilir. Cognito kullanıcı etkinliğine ve kaynak IP'lere bakın; gerekirse ilgili hesapları devre dışı bırakın |
| `<yığın>-mfa-verify-failed` | EMF `MfaVerifyFailed` (TOTP kurulumunda hatalı kod) | 5 dk'da > 10 (`mfa_verify_failure_alarm_threshold`) | API loglarında `msg=mfa_verify_failed`. Ele geçirilmiş oturumla kurulum denemesi olabilir |
| `<yığın>-mfa-reset-spike` | EMF `MfaReset` | 1 saatte > 3 (`mfa_reset_alarm_threshold`) | Denetim günlüğünde `mfa.reset` kayıtları (yapan, gerekçe). Yönetici hesabı ele geçirilmiş olabilir |
| `<yığın>-gate-lockout` | EMF `GateLockout` (güvenlik kapısı deneme sınırı aşıldı; sayaç başına pencere başına bir kez) | 1 saatte ≥ 3 (`gate_lockout_alarm_threshold`) | API loglarında `msg=gate_lockout` (apartman, tür, kapsam), denetim günlüğünde `gate.lockout` (kullanıcı). Kısa kod / plaka tahmini olabilir; ilgili görevli hesabını inceleyin |
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
- **Defter denetimi:** Her gece `ledger_audit` hesap bakiyelerini `LE#` toplamlarıyla, işlem dengesini, kapama kilidini, makbuz sayacını ve tamamlanmış online ödemelerin defter kaydını karşılaştırır. Finans 2.4 ile kapalı her ayın snapshot'ını defterden yeniden hesaplar (`fiscal_period_drift`), kapanıştan sonra kapalı aya yazılmış işlemi (`fiscal_closed_write`), kilit/dönem tutarsızlığını ve 30 dakikadan uzun süren yarım kapanışı (`fiscal_lock_mismatch`) raporlar. O1-4 ile arıza talebi ve bakım görevlerinin masraf özetini aktif masraf kilitleri (`EXPLINK#`) ve defterle karşılaştırır (`ticket_cost_mismatch`, `explink_orphan`). Sapma otomatik düzeltilmez; yalnızca platform alarmı üretir (düzeltme ters kayıtla).
- **Online tahsilat komisyonu (sakine yansıtılmaz):** Sakin borcunun tamamını öder, ek ücret ödemez (5464 s. Kanun m.17). Komisyonu apartman öder: ödeme anında her kalemin alt üye işyeri payı = tutar − platform ücreti (varsayılan %0,75, aşağı yuvarlanır) − POS tahmini (sözleşme oranı yukarı yuvarlanır; sabit ücret işlem başına bir kez, ilk kalemde). Tahsilatla aynı `TransactWriteItems` içinde "Online Tahsilat Komisyon Gideri" (`exp-online-collection-fee`, referans `ONLINE-FEE:<niyet>`) yazılır; böylece `online-collection` bakiyesi apartmana aktarılacak tutara eşittir. Sağlayıcının gerçek komisyonu ve tahminle farkı niyetin `settlement` kaydına yazılır, apartman defterini değiştirmez. Payı komisyonu karşılamayan çok küçük tutar online ödenemez (400).
- **Transactional outbox:** Defter ve belge yazımından doğan olaylar (`DUE_GENERATED`, `PAYMENT_RECEIVED`, `LATE_FEE_POSTED`, `ANNOUNCEMENT_PUBLISHED`, `POLL_PUBLISHED`) doğrudan yayınlanmaz; aynı `TransactWriteItems` içinde `OUTBOX#<eventId>` kaydı olarak yazılır (`events/outbox.ts`). Yazım yoksa olay da yoktur; toplu tahakkukta her kalemin olayı kendi kaydıyla birlikte yazılır.

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

**Güvenlik arayüzü ve izleme (`main`'e alındı)**

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

**Finans 2.2 — Avans mahsubu ve borç yapılandırma (`main`'e alındı: `1877a77`)**

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

**Finans 2.4 — Dönem kapanışı, bütçe, raporlar (`main`'e alındı: `52db844`)**

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

**Güvenlik görevlisi ekranları — plaka sorgu, misafir QR / kurye geçişi, kapı günlüğü (`feature/guvenlik-ziyaretci-qr`)**

- [x] Araç plakaları (`gate` modülü): Türk plaka biçimi (il kodu 01–81; 1 harf 4–5, 2 harf 3–4, 3 harf 2–3 rakam; Q / W / X yok) ve normalizasyon (`34 abc 123` → `34ABC123`); sakin oturduğu bölüme, yönetici her bölüme ekler; bölüm başına en fazla 4 aktif araç (eşzamanlı eklemede de: `VEHSLOT#<bölüm>` sürüm koşulu). Aktif plaka apartmanda tekildir: plaka başına `VPLATE#<ters plaka>` kaydı koşullu yazımla (`attribute_not_exists OR status = inactive`) tutulur; araç silinmez, pasife alınır. Her araç bölümde oturan bir sahibe (`ownerUserId`) bağlıdır: sakin kendisi, yönetici sahibi seçer (`GET /api/gate/units/:id/residents`, yalnızca ad). Sahip taşınınca araç görevliye pasif görünür, sınıra sayılmaz, yeni sakine görünmez ve plakayı yeni sakin devralır (eski kayıt pasife alınır)
- [x] Görevli plaka sorgusu: ters plaka anahtarı sondan eşleşmeyi `begins_with` sorgusuna çevirir (GSI yok, tek `Query`, en az 3 karakter, en fazla 10 sonuç). Yanıt yalnızca bölüm (blok · daire no), kayıtlı / aktif ve araç notudur; kişi adı, telefon, e-posta ve borç hiçbir görevli yanıtında yoktur
- [x] Misafir geçişi: sakin ad, tarih / tarih aralığı (≤ 31 gün, ≤ 90 gün ileri), tek / çoklu giriş, isteğe bağlı plaka ve görevli notu girer; rastgele (crypto, 144 bit) QR jetonu + karışan karakter içermeyen 8 haneli kısa kod (`K7M2-PQ4X`) alır. Jeton ve kod hiçbir kayıtta açık tutulmaz: geçiş kaydı ve dizinler (`GPTOK#<sha256>`, `GPCODE#<sha256(apartman:kod)>`) yalnızca özetleri taşır, dizinler geçerlilik + 7 gün sonra TTL ile düşer. QR ve kod yalnızca oluşturma yanıtında gösterilir; kaybedilirse **Yeni QR oluştur** (`POST /api/portal/gate/passes/:id/rotate`) yenisini verir, eskisi hemen çalışmaz. Geçişi oluşturan sakin taşınmışsa görevliye `Geçiş sahibi artık bu dairede oturmuyor` (`pass_host_left`) görünür. Paylaşım: Web Share API, yoksa bağlantı / kod kopyalama; bağlantı (`/gecis/<jeton>#<kod>`) oturumsuz açılır, API'ye istek atmaz, QR tarayıcıda çizilir (QR'da kişisel veri yok). Yönetici jeton / kod görmez
- [x] Görevli ekranı (`/admin/gate`, mobil öncelikli, büyük dokunma alanları): kamerayla QR okuma (tarayıcının yerleşik `BarcodeDetector`'ı, ek kütüphane yok; izin reddi / desteklemeyen tarayıcıda açıklama ve kısa kodla devam), geçiş kartı (misafir, ev sahibi bölüm, geçerlilik, karar) ve giriş / çıkış kaydı. Süresi dolmuş, başlamamış, iptal edilmiş, sahibi taşınmış ve kullanılmış tek girişlik geçiş kırmızı ve gerekçesiyle reddedilir. Tek girişlikte koşul `version + status = active + entryCount = 0`: iki görevli aynı anda okutursa yalnızca biri girer. Katı kural: misafir içerideyken (çıkışı kaydedilmeden) çok girişlik geçişte de ikinci giriş yazılmaz (`already_inside`, koşul `inside = false`)
- [x] Kurye: görevli bölüm + firma ile kaydeder; oturan sakin portalda (`/app/ziyaretci`, 15 sn'de bir yenilenir) 60 dakika içinde onaylar / reddeder; onay 2 saat geçerlidir (`COURIER_APPROVAL_VALID_MINUTES`), sonra kurye içeri alınamaz (`approval_expired`); onaylanan kurye içeri alınır ve çıkışı kaydedilir. Kayıtta sakine e-posta: bkz. **Bildirim devamı**
- [x] Kapı günlüğü: her giriş / çıkış (misafir, kurye, elle kayıt) kaydedenle birlikte `GLOG#<zaman>#<id>` + bölüm kopyası `GLOGU#<bölüm>#…` olarak yalnızca eklenir (TTL yok, silinmez); yönetici tarih / tür / bölüm filtresiyle, görevli dün + bugün, sakin yalnızca kendi bölümünü ve yalnızca **kendi üyelik başlangıcından** (zaman damgası: başlangıç günü ile üyelik kaydının yazıldığı andan geç olanı) sonrasını, kaydeden görevli kimliği olmadan görür. Aynı kural kurye listesinde geçerlidir; geçişlerde ayrıca devir günü başka üyenin oluşturduğu ve artık oturmayan sakinin geçişleri, araçlarda yalnızca bölümde hâlâ oturan sahiplerin araçları görünür (yeni kiracı önceki sakinin kayıtlarını görmez). Oluşturma ve giriş / çıkış `GIDEM#` idempotency kaydıyla aynı atomik yazımda; yönetici araç işlemleri ve geçiş iptali denetim günlüğüne yazılır
- [x] Web: `/admin/gate` (görevli: Misafir QR / kod, Plaka sorgu, Kurye, Kapı kayıtları; yönetim ayrıca Araçlar, Misafir geçişleri), `/app/ziyaretci` (kapıdaki kurye onayı, misafir geçişi oluşturma / QR paylaşımı / iptal, araçlarım, kapı kayıtları), herkese açık `/gecis/:token`. `qrcode` yine yalnızca QR gösteren ekranda dinamik yüklenir (`hooks/useQrDataUrl.ts`, MFA kurulumuyla ortak)
- [x] Testler: `apps/api/test/gate-vehicles.test.ts`, `gate-passes.test.ts` (rol matrisi, kiracı izolasyonu, plaka kuralları, süresi dolmuş / kullanılmış / iptal edilmiş geçiş, tek girişlik yarış, kurye onayı, sakin yalnızca kendi bölümü, depo koşul ifadeleri); web `lib/gate/gate.test.ts`, `pages/admin/gate/gate.test.tsx`

**Faz 3 — O1 Arıza / talep, periyodik bakım ve görevli iş listesi (`main`'e alındı: `47c55dc`)**

- [x] Talep çekirdeği (O1-1): durum makinesi (`open → assigned → in_progress ⇄ on_hold → resolved → closed`, iptal, 7 gün içinde yeniden açma), rol / yetki matrisi, okunur numara (`T-000123`), SLA (acil 4 sa, yüksek 24 sa, normal 72 sa, düşük 7 gün; site ayarı), append-only zaman çizelgesi ve iç notlar; talep + olay + indeks + idempotency + outbox + denetim tek atomik yazım
- [x] Sakin portalı uçları, S3 fotoğraf (geçici yükleme → `apartments/{apt}/tickets/{ticketId}/`), outbox olayları ve e-posta şablonları, `email.tickets` tercihi (O1-2); ekip daveti olan ama kişi kaydı olmayan personele e-posta için ekip kaydı yedeği
- [x] Periyodik bakım (O1-3): 11 hazır şablon (asansör aylık / yıllık muayene, hidrofor, jeneratör test / bakım, baca, yangın tüpü, havuz, su deposu, sulama, kazan), ay sonu sabitlemeli takvim, şablon değişince başlamamış görevlerin uyarlanması, idempotent görev üretimi, kontrol listesiyle tamamlama, görevden arıza; çözülen talebin otomatik kapanışı ve günlük operasyon özeti; EventBridge zamanlamaları (Terraform). Silme yok: iptal / arşiv durum alanıyla
- [x] Finans bağlantısı (O1-4): talep / görevden yeni gider veya var olan gideri bağlama (`EXPLINK#` kilidi, bir masraf tek işe), gerekçeli bağ kaldırma, ters kayıtla iptal edilen masrafın okuma anında düşülmesi; yönetici onaylı daireye yansıtma ("Onarım Yansıtma Gelirleri", malik / oturan seçimi, üst sınır); hazır hesap "Bakım / Onarım"; gece denetimi `ticket_cost_mismatch`, `explink_orphan`
- [x] Web yönetim (O1-5): **Arıza & Bakım** (`/admin/tickets`) pano (SLA özeti, filtreler, mobilde sütun seçici), filtreli liste + CSV, talep detay paneli (atama / üstlenme, not zorunlu geçişler, iç not, önce / sonra fotoğrafları, zaman çizelgesi, masraf kartı ve daireye yansıtma), bakım takvimi (ay / liste, gecikenler), görev paneli, şablon yönetimi; görevli **İşlerim** (`/admin/my-tasks`; bugün / bu hafta / havuz); Genel Bakış bekleyen işlerinde acil talep, SLA aşan ve geciken bakım
- [x] Web sakin (O1-6): **Talepler** (`/app/talepler`) listesi ve “onayınızı bekliyor” vurgusu, adım adım yeni talep (daire içi / ortak alan, benzer açık talep uyarısı, en fazla 6 fotoğraf), talep ayrıntısı (yalnızca herkese açık olaylar), 1–5 puanlı onay, yeniden açma, geri çekme; ana sayfa kartı; Hesabım → **Arıza e-postaları** anahtarı
- [x] Testler: `apps/api/test/tickets.test.ts`, `tickets-portal.test.ts`, `maintenance.test.ts`, `workcosts.test.ts`, `no-delete-writes.test.ts`; web `lib/tickets/model.test.ts`, `pages/admin/tickets/tickets.test.tsx`, `pages/resident/tickets/residentTickets.test.tsx`

**Faz 1 — Ekip, roller ve Hesabım (`main`'e alındı: `d3aa8b5`)**

- [x] Ekip ekranı (`/admin/team`): görevli / güvenlik / yönetici daveti, rol bitirme, yeniden davet; son yönetici koruması; denetçiye maskeli e-posta
- [x] Hesabım (`/admin/account`, `/app/account`): profil, iki adımlı doğrulama, bildirim tercihleri (e-posta, arıza e-postaları; kategori bazlı ekran: **Bildirim devamı**)
- [x] Alacak hesabı adlarının daire numarasına çevrilmesi (`fix:receivable-names`)

**Finans 2.3 — Sayaç / endeks dağıtımı (`main`'e alındı: `df310cc`, `6637dd6`)**

- [x] Hesap motoru: merkezi ısıtma varsayılanı %30 ortak (m²) + %70 tüketim, oran ve ortak anahtar (m², eşit, arsa payı) düzenlenebilir; su şablonları %0 ortak; en büyük kalan yöntemiyle sıfır kuruş fark; sıfır tüketimde tamamı ortak anahtarla
- [x] Sayaç sicili, değişim (eski kapanış + yeni açılış endeksi), emeklilik, fotoğraf kanıtı; okuma girişi ve CSV/Excel toplu okuma (`building_staff` dahil); geri giden endeks hata, 3× sıçrama uyarı
- [x] Önizleme–onay hash kilidi (`calcHash`), dönem bazlı idempotent tahakkuk (`MDP_<periodId>_<unitId>`), yarım onayın aynı komutla tamamlanması, toplu ters kayıt ve düzeltilmiş dönem
- [x] Fatura çift dağıtım kilidi (`EXPDIST`), gece denetiminde dönem mutabakatı ve takılı dönem tespiti; sakin tüketim geçmişi ve dağıtım dökümü PDF
- [x] Web: yönetici `/admin/meters`, görevli `/admin/meter-readings` (mobil, kamera fotoğrafı), sakin `/app/tuketim`

**Uçtan uca test düzeltmeleri — UI, RBAC, denetim (`main`'e alındı: `35e717f`)**

- [x] Denetim günlüğünde arıza / bakım / sayaç / finans dönemi olaylarının Türkçe etiketleri ve okunabilir yedek etiket; bakım görevi atama / başlatma denetim kaydı
- [x] `POST /api/audit/verify` ve "Zinciri şimdi doğrula"; gece işinde zincir doğrulamasının defter denetiminden ayrılması; panik yaratmayan uyarı metni
- [x] `building_staff` / `security_guard` menü ve doğrudan URL izolasyonu (`OFFICE_ROLES`), yönetim paneli üst bar taşma düzeltmesi
- [x] Sakin yeni talep sihirbazında konuma göre kategori (daire içi: su / elektrik / ısınma / yapı-kapı-pencere / güvenlik-diyafon / diğer)
- [x] Talepten yeni giderde tek adımda daireye yansıtma (oturan / kat maliki + son ödeme tarihi); iki adımlı "Daireye yansıt" korunur
- [x] Sakin portalı başlığında aktif site adı (yoksa YÖNESİST); giriş ekranı ve sekme başlığı markası

**Ölçek — arka plan toplu işleri (`main`'e alındı: `9e40696`)**

- [x] `bulkjobs` modülü, `bulk-jobs` + DLQ kuyruğu, kendini yeniden kuyruğa atan `bulk-worker`, iş kiralama ve ilerleme kaydı; toplu aidat (`POST /api/finance/dues/jobs`, büyük `/dues` → 202) ve büyük sayaç onayı (→ 202); zamanlanmış aylık aidatın büyük sitede iş olarak açılması
- [x] `BulkJobProgress` (aidat diyaloğu ve sayaç dönem kartları), `GET /api/jobs/:jobId`, `POST /api/jobs/:jobId/retry`
- [x] Sayaç önizlemesinde borçlu çözümlemesinin sınırlı eşzamanlılıkla (16) yapılması
- [x] 1.200 bölümlü ölçek testleri (`bulk-jobs-scale.test.ts`), Terraform plan testi

**Prod hazırlığı ve performans (`main`'e alındı: `0747082`)**

- [x] `infra/prod.tfvars`, `infra/environment.tf` (`custom_domain`, `production_guardrails`), `infra/PROD_DEPLOY.md`; CI prod planına `prod.tfvars` ekler, localhost'a düşen sessiz prod CORS varsayılanı kaldırıldı; sağlık kontrolü CORS listesini Terraform çıktısından okur
- [x] Web sayfa bazlı code-splitting (`React.lazy` + `Suspense`, yeni sürümde eksik parça için tek seferlik yenileme), vendor parçaları, `qrcode` dinamik yükleme
- [x] Gider tarih dizini (GSI1 `EXPDATE#<apartmentId>`): `listRecentExpenses` ile sayaç fatura seçicisi ve talep masrafı seçicisi tüm giderleri okumaz; eski kayıtlar için `backfill:expense-index`

**Ürün modülü — Ortak alan rezervasyonu (`feature/rezervasyon`)** (modül: `apps/api/src/modules/reservations/`)

- [x] Ortak alan tanımı: kapasite, gün bazlı açılış saatleri (Europe/Istanbul, :00 / :30), dilim uzunluğu, en uzun süre, rezervasyon penceresi (gün), daire başına aktif rezervasyon sınırı, yönetici onayı, sakin iptal süresi (saat), blok kısıtı, ücret (kuruş) ve gelir hesabı; idempotent oluşturma, sürümlü güncelleme, silme yok (`status: inactive`)
- [x] Çakışmasız rezervasyon: her alan + 30 dakikalık dilim için tek kilit öğesi (`RSLOT#<alan>#<başlangıç>`) `attribute_not_exists OR state = released` koşullu yazımla; eş zamanlı iki istekten yalnızca biri kazanır (409 `slot_taken`). Daire sayacı (`RGUARD#<alan>#<daire>`) aktif sınırını eş zamanlı isteklerde de korur. Rezervasyon + kilitler + sayaç + indeksler (`RBFAC#`, `RBUNIT#`) + idempotency (`RIDEM#`) + denetim tek `TransactWriteItems`; iptal / ret kilitleri `released` yapar. Yeni GSI yok
- [x] Durumlar: `pending` (onaylı alan) → `confirmed` / `rejected` (gerekçe); sakin iptali alanın iptal süresi dolmadan, yönetici iptali gerekçeyle her zaman. Tüm geçişler denetim günlüğüne (`reservation.*`)
- [x] Ücret tarafı rezervasyonu yapanın üyeliğinden belirlenip saklanır (dairede oturuyorsa oturan, oturmuyorsa malik carisi; belirsiz üyelik veya hisseli faturalanan oturmayan malikte ücretli rezervasyon reddedilir). Ücret: onayda Finans `chargeUnit` ile bu tarafa aidat benzeri tahakkuk (referans `RSV:<rezervasyon>`, son ödeme rezervasyon günü) ve rezervasyonun `confirmed` olması aynı atomik yazımda (`replaceRecords`, sürüm koşullu); onay gerektirmeyen ücretli alanda rezervasyonla birlikte, tahakkuk yapılamazsa yönetici onayına düşer. İptalde Finans `reverseTransaction` (idempotent `REV_<işlem>`); ters kayıt yapılamazsa iptal yine başarılıdır (`warning`), iade kuyruğuna (`RFEEQ#`, yalnızca hata durumunda; `open` → `resolved`, silme yok) düşer, yönetici yeniden dener veya gerekçeyle elle çözüldü işaretler. Modül defter satırı yazmaz
- [x] KVKK: sakin yalnızca kendi yaptığı veya dairedeki üyeliği başladıktan sonra yapılmış rezervasyonları görür ve iptal eder (yeni kiracı öncekinin kayıtlarını görmez); daire başına sınır görünürlükten bağımsız olarak dairenin güncel üyelerinin tüm aktif rezervasyonlarını sayar; diğer kayıtlar müsaitlikte yalnızca “dolu” dilimdir. Rezervasyon yazımı alanın sürümünü / aktifliğini aynı işlemde kontrol eder
- [x] Web: yönetim **Rezervasyonlar** (`/admin/reservations`; gün / hafta takvimi, onay bekleyenler, ortak alan tanımı ve pasife alma, ayrıntıda onay / gerekçeli ret / iptal / iade yeniden deneme), sakin **Rezervasyon** (`/app/rezervasyon`; alan → tarih → boş dilim → süre → onay, Rezervasyonlarım ve iptal)
- [x] Testler: `apps/api/test/reservations.test.ts`; web `lib/reservations/model.test.ts`, `pages/admin/reservations/schemas.test.ts`, `bookingDialog.test.tsx`, `pages/resident/reservations/myReservations.test.tsx`

**Y1 — Anket / oylama ve genel kurul hazırlığı**

- [x] `polls` modülü: taslak → yayın → (erken) kapatma, taslak iptali; yayındaki oylamanın sorusu, seçenekleri ve kuralları değişmez, silme yok (`status`). Erken kapatma gerekçe ister; yayın / kapatma / iptal denetim zincirine yazılır (`poll.*`)
- [x] Oy hakkı ve ağırlık mülkiyet modülünün oy listesinden (`buildVotingRoll`) oy listesi tarihinde (`rollDate` = açılış günü, Europe/Istanbul): kat malikleri oylamasında listedeki tüm paydaşlar, sakin oylamasında ayrıca o gün geçerli tüm üyelikler (kiracı dahil). Liste oy listesi gününden önce **dondurulmaz**: hemen açılan oylamada yayında, planlı oylamada açılıştan sonraki ilk oy / erken kapatma yazımında (**sistem işlemi**: ilk oyu veren sakin denetim kaydına aktör / istek bilgisi olarak yazılmaz, oylamanın `updatedBy` / `updatedAt` alanları değişmez), hiç oy almadan biten oylamada ise günlük `maintenance_tasks` işinde (04:10) sistem olarak; her durumda oylama kaydıyla aynı `TransactWriteItems` içinde (`POLLROLL#<pollId>#<kova>`: bölüm / arsa payı / oy hakkı sahipleri / ağırlık). Sonra sonuç, katılım ve oy hakkı yalnızca bu görüntüden okunur; okumalar (yönetici, denetçi, sakin) hiçbir şey dondurmaz, dondurulmamışsa canlı ön izleme gösterir (`rollFrozen: false`)
- [x] Bölüm başına tek oy: `POLLVOTE#<pollId>#<unitId>`; ilk oy `attribute_not_exists`, sonraki oy (hisseli mülkiyette başka paydaş dahil) sürüm koşullu üstüne yazım ve oylama bitene kadar öncekinin yerine geçer. Her oy aynı `TransactWriteItems` içinde oylamanın açık olduğunu, yazımdan hemen önce alınan zamanla `ConditionCheck` ile doğrular; erken kapatmayla yarışan oy 409, aynı oyun eşzamanlı ikinci gönderimi başarı
- [x] Sonuç: seçenek başına bölüm sayısı ve arsa payı toplamı (BigInt, bölüm paydalarının EKOK'u ortak payda; kesirler metin olarak döner, taşma yok), katılım (bölüm / arsa payı) ve seçilen ağırlığa göre **kullanılan oyların salt çoğunluğu** (yarıdan fazlası; eşitlikte kazanan yok). Arsa payı ağırlıklı oylama, arsa payı eksik bölüm varsa yayınlanamaz (422); eksik bölüm varsa arsa payı toplamları gösterilmez
- [x] Gizli oylama (varsayılan): sürerken seçenek dağılımı kimseye gösterilmez; hangi bölümün oy kullandığı oylamanın **planlanan bitişine** kadar gizlidir (yalnızca sayı); bölüm bazında seçim hiçbir evrede gösterilmez; oylar denetim zincirine yazılmaz. Açık gizli oylama en az 3 bölüm oy kullanmadan erken kapatılamaz (422). Açık oylamada yönetici bölüm bazında seçimi görür; ara sonuç açılırsa yalnızca bölümü oy kullanmış sakinler görür
- [x] `POLL_PUBLISHED` outbox olayı → bildirim worker'ı (kat malikleri oylamasında malikler, sakin oylamasında tüm üyeler) ve "Yeni oylama" e-postası; SNS bildirim aboneliği filtresine eklendi (**`infra` apply gerekir**)
- [x] Web: yönetici `/admin/polls` (durum filtresi, taslak penceresi, onaylı yayın / iptal / gerekçeli erken kapatma, sonuç ve bölüm bazında katılım), sakin `/app/oylamalar` ve `/app/oylamalar/:pollId` (oy verme / değiştirme, "son oy geçerli" açıklaması, kendi oyum, sonuçlar); iki düzende menü Duyurular'ın yanında
- [x] Genel kurul (`assemblies`): olağan / olağanüstü toplantı kaydı (tarih-saat, yer veya https çevrim içi bağlantı, gündem). Oy listesi toplantı günü için mülkiyet modülünden; toplantı başladıktan sonraki ilk katılım / yeter sayı / sayım **yazımında** dondurulur (`ASMROLL#...`), sonrasında toplantı bilgisi değişmez. Katılım, yeter sayı ve sayım toplantı başlamadan reddedilir (409). Hazirun cetveli okumadır, hiçbir şey dondurmaz: liste dondurulmamışsa canlı listeden "ön izleme" PDF'i. Katılım bölüm başına `ASMATT#<toplantı>#<bölüm>` (asaleten + temsilci paydaş / vekaleten + vekil: apartman kişisi ise `userId`, değilse ad-soyad / katılmadı; toplantının `planned` olduğu `ConditionCheck` ile, sürüm koşullu). Oluşturma, düzenleme, iptal, dondurma, yeter sayı ve sayım denetime yazılır
- [x] KMK m.30 / m.31 (bkz. **Hukuki yorum**): toplantı yeter sayısı kat maliklerinin **sayıca** (ayrı kişiler; hisseli bölüm temsilcisiyle bir kez) ve toplam **arsa payının** yarısından fazlası; arsa payı girilmemiş bölüm varsa yeter sayı sağlanmış sayılmaz. Karar **katılanların oylarının çoğunluğu** (bölüm başına bir oy, çekimser kabul sayılmaz). Bütün oylar sınırsız bölüm sayısıdır; birden fazla bölümün oyunu kullanan kişinin (tek malik veya hisseli bölüm temsilcisi) oyu `floor(bütün oylar / 3)` ile sınırlıdır, kişi bazında tüm bölümleri üzerinden. Vekil 40 ve daha az bölümde en fazla iki kat malikini, üstünde bütün oyların %5'ini temsil eder; aşan katılım 422. Ekranda kat maliki ve bölüm / oy sayıları ayrı gösterilir. Yeter sayı `POST /:id/quorum` ile (yalnızca toplantı başladıktan sonra, denetimli) tutanağa geçirilir; "sağlanmadı" için katılım girilmiş olmalı ya da açıkça "kimse gelmedi" (`noAttendance`). **İkinci toplantı** yeter sayısızlığı tutanakta olan aynı apartmanın ilk toplantısına (`firstMeetingId`) bağlanır, ondan en geç 15 gün sonradır, yeter sayı aranmaz
- [x] Hazirun cetveli PDF: mevcut rapor şablonu (`renderReportPdf`, gömülü Noto Sans) imza payı için yüksek satır ve satır çizgisi seçeneğiyle; sıra, blok / daire, kat maliki (paydaşlar ve payları), arsa payı, katılım, vekil, imza; toplamlar, yeter sayı kuralı ve divan imza satırı. S3 `apartments/<apt>/reports/<yyyy>/<mm>/assembly-hazirun-...pdf`, veri özetiyle önbellekli, 5 dk imzalı link
- [x] Web: yönetici `/admin/assemblies` (toplantı listesi ve penceresi; ayrıntı panelinde yeter sayı kartı, gündem sayımı, bölüm bazında katılım girişi, hazirun PDF, gerekçeli iptal)

**Hukuki yorum (avukat / ekip onayı bekleyen noktalar)** — Y1 hesapları aşağıdaki yorumlarla yapılır; KMK metni ve içtihatla teyit edilmeli:

- *Bütün oylar* (m.31): her bağımsız bölüm bir oy, sınırsız toplam = bölüm sayısı; payda hiçbir zaman küçültülmez. Üçte bir sınırı `floor(bütün oylar / 3)` (kesir atılır), bölüm sayısı 3'ten azsa en az 1.
- Sınır **gerçek kişi** başına: kişinin tek malik olduğu ve hisseli bölümlerde temsilci olarak oyunu kullandığı tüm bölümler birlikte sayılır. Hisseli bölüm asaleten veya vekaleten katıldığında paydaşların temsilcisi (kişi) seçilmek zorundadır; oy o kişiye yazılır.
- Kat maliki *sayısı* oy listesinden sabit kimlikle hesaplanır (hisseli bölüm, ilk kayıttaki temsilcisiyle, yoksa bölüm olarak bir kez); katılım girildikçe toplam değişmez.
- Toplantı yeter sayısının *sayı* ölçütü (m.30) **kat maliki kişi sayısı**dır (bölüm sayısı değil); hisseli bölüm temsilcisiyle bir kez sayılır. Arsa payı ölçütü toplam arsa payının yarısından fazlası; arsa payı eksik bölüm varsa sağlanmamış sayılır.
- Karar yeter sayısı (genel kural, m.30): katılanların oylarının (kişi sınırı uygulanmış) çoğunluğu; çekimser ve oy kullanmayan katılımcı kabul sayılmaz. Nitelikli çoğunluk ve oybirliği aşağıda (*Genel kurul devamı*).
- Vekalet (m.31): 40 ve daha az bölümde bir kişi en fazla iki kat malikine; üstünde bütün oyların (sınırsız) %5'ine (kesir atılır) vekil olabilir. Vekil üye ise kimliğiyle, değilse ad-soyadla eşleştirilir.
- İkinci toplantı ilk toplantıdan en az 7 (m.29/3, 7 gün dahil) en geç 15 gün sonra (m.30; Istanbul takvim günü) ve yeter sayı aranmaz.
- Oy listesi tarihi: oylamada açılış günü, kurulda toplantı günü (Europe/Istanbul). Oylamalar (anket) kurul kararı sayılmaz: kazanan kullanılan oyların salt çoğunluğu, kişi başı üçte bir sınırı oylamada uygulanmaz.

*Genel kurul devamı — karar çoğunlukları, çağrı, tutanak (kaynak: mevzuat.gov.tr 634 sayılı KMK konsolide metni, 7579 sayılı Kanun değişiklikleri dahil; hepsi **avukat onayı bekler**):*

- **Sayım ölçütü kanunun ifadesinden:** "sayı (ve arsa payı) çoğunluğu" aranan yerde (m.30/1 toplantı yeter sayısı, m.34 yönetici, m.41 denetçi, m.42 faydalı yenilik / ısıtma) ve m.19/2 "kat maliklerinin ... yazılı rızası"nda kat maliki **kişi** sayılır: toplantı yeter sayısıyla aynı kimlik kuralı (tek malikte malik; hisseli bölüm oy listesindeki temsilcisiyle, yoksa bölüm olarak bir kez; birden fazla bölümü olan malik tek kişi). "Oyu" aranan yerde (m.28 "beşte dördünün oyu", m.30 katılanların oy çokluğu, özel "üçte iki") **m.31 oyu** sayılır: bölüm başına bir oy, kişinin oyu `floor(bütün oylar / 3)` ile sınırlı (kişi: tek malikte malik, hisseli bölümde katılımdaki temsilci).
- **Hazır karar türleri:** genel karar ve işletme projesi (m.30, m.37) → katılanların oy çokluğu; yönetici seçimi (m.34 "hem sayı hem arsa payı bakımından çoğunluğu"), denetçi seçimi (m.41) ve faydalı yenilik / ilave, ısı yalıtımı, yakıt veya ısıtma sistemi değişikliği (m.42) → bütün kat maliklerinin kişi sayısı VE arsa payı çoğunluğu; ortak yerlerde inşaat veya tesis, dış cephede farklı renk boya (m.19/2 yazılı rıza; olağan bakım ve onarım m.35/b uyarınca yöneticinin işidir, beşte dört gerektirmez) → kişi sayısıyla beşte dört; yönetim planı değişikliği (m.28) → oyların beşte dördü; konut olarak kayıtlı bölümün m.24/2'de sayılan işyerine dönüştürülmesi (m.24/1'deki hastane, klinik, ilaç laboratuvarı vb. oybirliğiyle de açılamaz), 2.000 m² ve üzeri binada merkezi ısıtmadan bireysele geçiş (**m.42/4**), hakla kayıtlama / arsanın bölünmesi / çatı ve dış duvar reklam kirası (m.45), kat veya bölüm ilavesi (m.44) → oybirliği.
- **"Bütün" kat malikleri:** m.34 ve m.42 metninde "bütün" sözcüğü yoktur. Çoğunluk katılanların değil bütün kat maliklerinin çoğunluğu olarak okundu (ikinci toplantıda da); karşı görüş, bu maddelerde de m.30 toplantısında katılanların çoğunluğunun yeteceğidir. Teyit edilmeli.
- **Payda:** nitelikli çoğunlukta payda dondurulmuş oy listesindeki tüm kat malikleri (kişi) / tüm oylar / toplam arsa payıdır; katılmayan kabul sayılmaz. İlk toplantıda m.30 toplantı yeter sayısı ayrıca aranır.
- **Üçte bir sınırı paydada da:** "bütün kat maliklerinin oyu" tüm bölümlerin aynı kişi sınırıyla sayılan oyudur; aksi halde bölümlerin üçte birinden fazlasına sahip malik varken herkes kabul etse bile beşte dört sağlanamazdı. Sınırın tabanı (bütün oylar) sınırsız bölüm sayısıdır. Kişi sayımında sınır uygulanmaz (kişi zaten bir kez); arsa payı sınırlanmaz.
- **Yuvarlama:** çoğunluk yarıdan fazla (`kabul × 2 > payda`); beşte dört en az 4/5, üçte iki en az 2/3 (yukarı yuvarlanır: 7'de 6, 10'da 8; 9'da 6, 10'da 7). Arsa payı aynı kuralla BigInt ortak paydada.
- **Arsa payı eksikse** arsa payı gereken karar **hesaplanamaz**: kayıt yazılmaz (422), kalıcı "ret" oluşmaz. Oy listesi dondurulmadan önce ekranda uyarı. Kişi / oy kuralları etkilenmez.
- **Oybirliği:** oy listesindeki her bölüm katılmış ve kabul etmiş olmalı. Toplantı dışında sonradan alınan yazılı rıza (m.19/2, m.44 noter) sistemde kaydedilmez.
- **m.31/4 (doğrudan ilgili malik):** kendisini doğrudan ilgilendiren konuda kat malikinin oy kullanamayacağı hüküm modellenmedi: yönetici o bölümü "oy kullanmadı" girer; nitelikli çoğunlukta bu malikin paydada kalıp kalmayacağı teyit edilmeli.
- **Toplu yapı (m.66-73):** toplu yapı kurulları modellenmedi. 7579 ile m.70'teki toplu yapı yönetim planı değişikliği **üçte iki** çoğunluğa bağlandı; bunun için hazır tür yok, "özel" türde "bütün kat maliklerinin oylarının üçte ikisi" seçilebilir (oy olarak sayılır; kişi / temsilci kurulu ayrımı teyit edilmeli).
- **Çağrı (m.29):** 15 gün önceden imza karşılığı veya taahhütlü mektupla çağrı m.29/2'de **olağanüstü** toplantı içindir: yalnızca olağanüstü toplantıda 15 günden az kala uyarı. Olağan toplantı yönetim planındaki zamanda yapılır (m.29/1): yalnızca "yönetim planınızdaki süreyi kontrol edin" notu. İlk çağrıda ikinci toplantının yeri ve zamanı bildirilir ve iki toplantı arası **7 günden az olamaz** (m.29/3): 7 günden kısa ikinci toplantı ve plan **reddedilir** (7 gün dahil geçerli; en fazla 15 gün, m.30); ikinci toplantı bildirilen plandan farklıysa uyarı. Sistem e-postası nezaket bildirimidir, kanun ve yönetim planındaki çağrının yerine geçmez.
- **Kararlar değişmez:** düzeltme gerekçeli yeni kayıttır, eski kayıt silinmez. Y1'den kalan (karar kaydı olmayan) sayımın düzeltmesi ilk değişmez kayıttır ve eski sayımı içinde saklar; tutanak ve karar defterinde "Y1 sayımı" olarak görünür. İlk karardan sonra katılım donar; tutanaktaki yeter sayı tutanağa geçirildiği andaki anlık görüntüdür.
- **Karar defteri (m.32):** kararlar noterce onaylı karar defterine yazılır ve toplantıda bulunanlarca imzalanır, aleyhte oy verenler gerekçe yazar. Sistemin tutanak ve karar defteri PDF'leri bu defterin yerine geçmez.
- **Sakin görünümü (KVKK):** yalnızca bugün aktif malik üyeliği olan kullanıcı görür (menü öğesi de yalnızca maliklere); geçmiş toplantılar da gösterilir (kararlar halefleri de bağlar). Kiracıya kurul hakkı tanıyan hüküm bulunmadığından kiracı göremez. Yanıtlarda başka maliklerin adı ve bölüm bazında katılım / oy yoktur; tutanak PDF'inde yalnızca yöneticinin girdiği divan adları yer alır.

- [x] Testler: `apps/api/test/polls.test.ts` (roller, tenant izolasyonu, tek oy / paydaş değiştirmesi, arsa payı matematiği, salt çoğunluk, gizlilik, kapalı oylama, tarih penceresi, oy listesi tarihi, DynamoDB koşulları), `assemblies.test.ts` (yeter sayı sayı / arsa payı ayrışması, ikinci toplantı, karar eşiği, vekil uyarısı, iptal, hazirun PDF önbelleği); web `pages/admin/polls/schemas.test.ts`, `pages/resident/polls/residentPolls.test.tsx`, `pages/admin/assemblies/schemas.test.ts`

**Güvenlik kapısı ve ihale devamı (`feature/kapi-ihale-devami`)**

- [x] Kısa kod / QR doğrulama ve plaka araması için kullanıcı ve apartman başına deneme sınırı (`gate/throttle.ts`): 15 dk sabit pencere, `GTHR#<tür>#U#<kullanıcı>#<pencere>` / `GTHR#<tür>#A#<pencere>` sayaçları (koşullu `UpdateItem ADD`, tablonun `ttl` özniteliğiyle pencere + 1 saat sonra düşer). Kullanıcı sayacı: her istek 1, bulunamayan kısa kod 6, bulunamayan QR jetonu 2 puan (doğrulama 60, plaka 120); sınırı aşmış hesap apartman sayacına hiç dokunmaz. Apartman sayacı yalnızca doğrulama başarısızlık cezalarını sayar (150; başarılı okumalar saymaz, yoğun site kendini kilitlemez; plakada yok). Aşımda `429` + `Retry-After`; sınırı ilk aşan yazım `gate.lockout` denetimi + `GateLockout` EMF metriği. API Gateway'de iki rota hassas rota listesinde (platform geneli 100/sn, burst 200: yalnızca arka ucu korur) ve `<yığın>-gate-lockout` alarmı (**`terraform apply` gerekir**)
- [x] iPhone Safari QR okuma: `BarcodeDetector` yoksa veya `qr_code` desteklemiyorsa kareler uzun kenarı 480 px'e küçültülüp `jsqr` **1.4.0** (Apache-2.0, bağımlılıksız; tam sürüm sabit) ile 250 ms'de bir çözülür. Kütüphane yalnızca tarama ekranında, yedek motor seçilince dinamik `import` ile ayrı parça olarak yüklenir; sekme arka plana geçince kamera kapanır, dönünce yeniden açılır. Kısa kodla elle giriş aynen kalır. Çözücü testi `qrcode` ile üretilen QR görüntüsüyle (ağ yok)
- [x] Taşınmada geçiş ve araçların pasife alınması (`gate/departures.ts`): günlük `maintenance_tasks` işi (04:10) son 7 günde biten / değişen ve bugün bölümde oturmayan üyelikleri (taşınma / cari kapama, iptal, kiraya veren malik, mülk devri) tarar; o kullanıcının o bölümdeki aktif, süresi dolmamış geçişleri `revoked` (`revokeReason: taşınma`), sahibi olduğu aktif araçlar `inactive` olur, bağlı plaka dizini serbest kalır. Sürüm koşullu, idempotent, `gate.departure_release` denetimli; okuma anındaki üyelik kontrolü güvenlik ağı olarak kalır. Bitiş günü boyunca sakin hâlâ oturur sayılır (taşınma günündeki nakliye geçişi bozulmaz). Cari kapamayla biten üyelik geri alınabildiği için bitiş (veya kaydın değiştiği gün) + 3 gün geçmeden dokunulmaz; tarama **sonrasında** geri alınan kapamada geçişler yeniden oluşturulur, araçlar yönetimce yeniden etkinleştirilir (otomatik geri dönüş yok). Bir adayın hatası diğerlerini durdurmaz: `msg=gate_departure_failed` logu (apartman / bölüm) + `GateDepartureFailed` metriği ve `<yığın>-gate-departure-failed` alarmı (**`terraform apply` gerekir**)
- [x] İhale bildirimleri: `TENDER_PUBLISHED`, `TENDER_DECIDED`, `TENDER_CANCELLED` (yalnızca yayından sonra) → apartmanın güncel üyeleri; `TENDER_REPLIED` → yanıtın kaydettiği, yazıldığı anda yanıtlanmamış soruların (`answers`) sahipleri (hâlâ üyeyse): her soru sonrasındaki ilk yönetim yanıtında bir kez; art arda yanıtlar aynı kişiye tekrar gitmez, yanıtla eş zamanlı yazılan soru bir sonraki yanıtta kapsanır (eski, listesiz yanıtta önceki yönetim yanıtından bu yana sorulanlar). Olaylar ihale yazımıyla aynı atomik işlemde outbox'a girer, payload yalnızca kimlik; worker ihalenin güncel halini okur, durum olayla uyuşmuyorsa (örneğin iptal edilmiş ihalenin yayın e-postası) göndermez. Yeni tercih kategorisi `tenders` (`emailTenders`, duyurulardan ayrı: ihale ortak gider kararıdır); Hesabım'da "İhale ve teklifler". SNS `notification_event_types` ve `serverless.tftest.hcl` güncellendi (**`terraform apply` gerekir**)
- [x] Karardan Finans'a aktarım: `POST /api/tenders/:id/expense` mevcut Finans gider servisini (`recordExpense`, iş bağlantısı) kullanır; gider + defter + ihaledeki `expense` bağı (sürüm koşullu) + denetim tek atomik yazım, ihale başına bir gider. Ödeme kaynağı ihalede olmadığından web "Gider kaydı oluştur" ile mevcut gider penceresini karardan ön doldurulmuş açar (KDV dahil toplam, firma, `İhale <id>: <başlık> · Karar <referans>` açıklaması, kategoriye göre gider kalemi); kaydedilen gider karar kartında Finans bağlantısıyla görünür; Finans'ta ters kaydedilen gider kartta "Gider ters kaydedildi" olarak görünür ve yeni gider kaydı yeniden sunulur (eski gider geçmişte, denetimde `replacesExpenseId`). Gider bağına `tender` türü eklendi (`ExpenseWorkLink`)

**Bildirim devamı — kapı, rezervasyon ve tercih ekranı (`feature/bildirim-devami`)**

- [x] Güvenlik kapısı: görevli kurye kaydedince bölümde **oturan** güncel üyelere `GATE_COURIER_ARRIVED` (portalda onay / ret; e-postada firma ve Istanbul saatiyle son yanıt), misafir geçişiyle her girişte geçişi oluşturan sakine `GATE_GUEST_ENTERED` (giriş anı, tek / çok girişli, geçerlilik). Olay kurye / giriş kaydıyla aynı `TransactWriteItems`'ta outbox'a girer, kimlik deterministik (`…:<kurye>`, `…:<geçiş>:<giriş sırası>`). Payload'da misafir adı, plaka, not, firma ve telefon yok: worker kurye kaydını okur ve yanıtlanmış / iptal / süresi dolmuş kuryeye bildirim göndermez. Alıcılar portal görünürlüğüyle aynı: taşınan, dairede oturmayan malik ve devir günü kuryeden sonra gelen sakin almaz. Portalın 15 sn'lik yenilemesi yedek olarak kalır
- [x] Rezervasyon: yönetimin onayı (`RESERVATION_APPROVED`), reddi (`RESERVATION_REJECTED`, gerekçe) ve iptali (`RESERVATION_CANCELLED`, gerekçe + ücret iadesi durumu: iade edildi / işleniyor / elle düzeltildi / tahakkuk yok) rezervasyonu yapana, yalnızca hâlâ dairenin üyesiyse. Olay kararı yazan işlemle aynı atomik yazımda; ücretli onayda Finans tahakkuku ve rezervasyon güncellemesiyle aynı batch'te (`WorkLinkWrite.outbox`). Sakinin kendi iptali ve otomatik onay olay üretmez. Gerekçe payload'da taşınmaz, worker rezervasyon kaydından okur; yönetimin onay notu iç nottur, e-postaya girmez. SNS standart konu (sırasız teslim): kaydın güncel durumu olayla uyuşmuyorsa (tekrar denenen onay iptalden sonra gelirse) veya kayıt yoksa bildirim gitmez. Yönetim iptalinde ücret iadesi ayrı yazımla tamamlandığından, worker iptalden sonraki 30 sn içinde hatasız `reversal_pending` görürse olayı erteler (SQS görünürlük süresi sonra yeniden teslim; süre geçince durum ne ise gönderilir, sonsuz erteleme yok)
- [x] Kategori bazlı e-posta tercihi (`modules/notifications/categories.ts`): aidat / tahsilat, duyurular, arıza / talep (günlük operasyon özeti dahil), ziyaretçi / kurye, rezervasyon, anket / oylama. Worker kategoriyi olay türünden (`POLL_*` dahil), kanal yoksa şablon adından çözer; kapatılan kategori `skipped: opted_out` sayılır. Kayıt `NOTIFPREF` öğesinde düz öznitelikler (`emailEnabled`, arıza için O1-2'nin `ticketEmails` adı, `emailFinance`, `emailAnnouncements`, `emailGate`, `emailReservations`, `emailPolls`); güncelleme `UpdateExpression SET` ile yalnızca gönderilen alanları yazar: iki cihaz / eski sekme birbirinin seçimini ezmez. Log kanalı yalnızca `eventId`, `userId` ve şablonu yazar (gerekçe, firma gibi serbest metin loga girmez)
- [x] Web: Hesabım → **Bildirimler** kartı (`pages/account/NotificationPreferencesCard.tsx`; `/admin/account`, `/app/account`): e-posta ana anahtarı ve altı konu anahtarı; her değişiklik yalnızca o alanı gönderir
- [x] SNS `notification_event_types` filtresi ve `serverless.tftest.hcl` listesi yeni olay türleriyle güncellendi (**`terraform apply` gerekir**; uygulanmadan yayınlanan yeni olaylar SNS'te elenir)
- [x] Testler: `apps/api/test/gate-notifications.test.ts`, `reservation-notifications.test.ts`, `notification-preferences.test.ts`; web `pages/account/NotificationPreferencesCard.test.tsx`

**Arıza & bakım v2 — ekipman sicili ve görevlinin tahmini tutar notu (`feature/ekipman-sicili`)** (modül: `apps/api/src/modules/equipment/`)

- [x] Ekipman sicili (`EQUIP#<equipmentId>`, sürümlü, silme yok: `active` / `out_of_service` / `retired`): ad, kategori (asansör, jeneratör, hidrofor / pompa, kazan / ısıtma, yangın sistemi, kamera / güvenlik, otomatik kapı / bariyer, havuz, diğer; arızayla ortak olanlar aynı kimlik), blok + serbest konum, marka / model / seri no, kurulum, garanti bitişi, servis firması (Finans tedarikçi carisine bağlanabilir; firma telefonu / e-postası), servis sözleşmesi bitişi, son / sonraki periyodik kontrol ve asansör etiketi, not. Her yazım denetim zincirinde
- [x] Belgeler (garanti belgesi, servis sözleşmesi, periyodik kontrol raporu / etiketi, kılavuz): private S3, imzalı PUT ile kullanıcıya bağlı geçici yükleme → kalıcı anahtar, 5 dk imzalı görüntüleme, arşivleme (silme yok); sözleşme belgesi bina görevlisine gösterilmez
- [x] Bağlantılar: talep, bakım şablonu ve (şablondan kopya) bakım görevi `equipmentId` taşır; ekipman aynı apartmanda aranır, hizmetten çıkmış ekipmana yeni bağlantı kurulamaz; eski kayıtlar ekipmansız aynen çalışır. Her yeni / uyarlanan bakım görevi bağlantıyı açıkça yazar (`null` dahil): şablon başka ekipmana bağlanınca tamamlanmış görevlerin geçmişi yerinde kalır; bağlantı alanı **hiç olmayan** (v2 öncesi) görevler şablonun güncel ekipmanına sayılır. Geçmiş, `GET /api/maintenance/tasks?equipmentId=`, görev görünümü ve görevden arıza aynı kuralı (`taskEquipmentId`) kullanır. Hizmetten çıkan ekipmana yeni görev / görevden arıza bağlanmaz (şablonun bağlantısı geçmiş için kalır; hizmetten çıkarma yanıtı ve ekran bağlı aktif şablonları gösterir). Ekipman geçmişi (son 5 yıl, `years` 1–10) bağlı talepleri ve görevleri Istanbul günüyle, yönetim / denetçiye ters kayıtlar düşülmüş yıl bazında masrafı (workcosts özetinden; ters kayıt kontrolü tek toplu BatchGet) gösterir
- [x] Hatırlatmalar: garanti, servis sözleşmesi ve periyodik kontrol tarihleri günlük `OPERATIONS_DIGEST`'e eklendi (`equipmentExpiring`, yalnızca yönetime; yeni olay türü yok, `tickets` e-posta tercihine tabi): her gün önümüzdeki 30 gün içinde dolacak ve son 30 günde dolmuş olanlar, uzun süredir dolmuş sözleşme / kontroller yalnızca **pazartesi** (haftalık tam liste); olayda en fazla 100 kalem, sayı (`equipmentTotal`) kesilmeden önce. Yönetim ekranında tam liste / rozet
- [x] Görevlinin tahmini tutar notu: talep ve bakım görevinde kuruş (0 dahil) + kısa not, sürüm kontrollü, denetimli, deftere yazılmaz; yazma: yönetim ve talebin **güncel** görevlisi (açan görevli yalnızca talep atanmamışken); yönetim, görevli ve denetçi görür, sakin portalı ve güvenlik görünümü hiçbir uçta döndürmez. Bina görevlisine bakım görevi masraf özeti ve ekipmanın Finans tedarikçi cari kimliği dönmez
- [x] Web: **Ekipman** (`/admin/equipment`, menüde Arıza & Bakım'ın yanında): yaklaşan / dolan tarih listesi, arama + filtreler (kategori, blok, garanti bitişi, durum, hatırlatması olanlar), kayıt / düzenleme penceresi, ayrıntı paneli (durum, belgeler, geçmiş ve yıllık masraf tablosu); talep oluşturma / düzeltme ve bakım şablonu formunda ekipman seçimi; talep ve görev ayrıntısında tahmini tutar kartı
- [x] Testler: `apps/api/test/equipment.test.ts` (roller, kiracı izolasyonu, sürüm çakışması, silme yok, belge anahtarları, geçmiş / masraf, özet içeriği, sakinde tahmini tutar yok); web `pages/admin/equipment/equipment.test.tsx`

**Genel kurul devamı — karar çoğunlukları, tutanak / karar defteri, çağrı, sakin görünümü (`feature/genel-kurul-devami`)** (hesap yorumları: yukarıdaki **Hukuki yorum**)

- [x] Gündem maddesi başına karar türü ve gerekli çoğunluk (`modules/assemblies/majority.ts`, saf): katılanların oy çokluğu; bütün kat maliklerinin kişi sayısı ve arsa payı çoğunluğu; kişi sayısıyla beşte dört; oyların beşte dördü; oybirliği; yalnızca "özel" türde kişi + arsa payıyla beşte dört ve oyların üçte ikisi. Hazır türler (genel karar, işletme projesi, yönetici seçimi, denetçi seçimi, faydalı yenilik / ısıtma, ortak yerde inşaat / dış cephe, yönetim planı değişikliği, kullanım amacı değişikliği, merkezi → bireysel ısıtma, hakla kayıtlama / arsanın bölünmesi, kat ilavesi) kanundaki çoğunluğa sabittir, ekranda ilgili madde ve uyarı (ör. m.24/1, m.35/b) gösterilir. Çoğunluk gündemle birlikte oy listesi dondurulunca değişmez
- [x] Karar hesabı dondurulmuş oy listesinden: payda bütün kat malikleri (kişi) / bütün oylar / toplam arsa payı; "sayı" aranan kurallarda kişi (toplantı yeter sayısıyla aynı kimlik), "oyu" aranan kurallarda m.31 oyu (kişi sınırı pay ve paydada); arsa payı BigInt ortak paydada. Nitelikli çoğunlukta bölüm bazında oy zorunlu (aynı kişinin bölümleri, kişi sayımında aynı malike düşen bölümler aynı oyu alır). Arsa payı eksikse arsa payı gereken karar 422 (kayıt yazılmaz) ve dondurmadan önce uyarı. Sonuç kabul / ret ile gerekli en az oy / kişi / arsa payı ve ret gerekçeleri
- [x] Kararlar değişmez: `ASMDEC#<toplantı>#<madde>#<sıra>` (`attribute_not_exists`, toplantı kaydıyla aynı `TransactWriteItems`); aynı madde için ikinci kayıt yalnızca `correctionReason` ile düzeltme (`supersedes`, denetim `assembly.tally_correction`). Y1'den kalan sayımın düzeltmesi sıra 1 olur ve eski sayımı (`legacyTally`) saklar. İlk kararla katılım donar (`attendanceLockedAt`, katılım yazımı `ConditionCheck` ile 409). Karar kaydedilmiş toplantı iptal edilemez
- [x] Tutanak: divan (başkan, en fazla 3 yazman / oy toplayıcı; adları yönetici girer, denetim kaydına yalnızca sayıları) ve madde başına görüşme notları (`PUT /:id/minutes`; boş metin / `null` notu temizler); `POST /:id/finalize` tutanağı kesinleştirir (`held`): sonra katılım, yeter sayı, tutanak ve yeni karar yazılamaz, düzeltme yeni kayıtla. Yeter sayı sağlandıysa başkan ve en az bir yazman zorunlu (kimse gelmediyse aranmaz). Kesinleşmiş ilk toplantıya ikinci toplantı bağlanabilir
- [x] PDF'ler (`renderReportPdf`, gömülü Noto Sans; şablona satır kaydırmalı paragraf eklendi): toplantı tutanağı (toplantı bilgisi, çağrı, divan, tutanağa geçirildiği andaki KMK m.30 yeter sayı anlık görüntüsü, her madde için karar türü, gerekli çoğunluk, kabul / ret / çekimser oy - kişi - bölüm - arsa payı, sonuç, ret gerekçesi, düzeltmeler ve Y1 sayımları, görüşme notları, imza satırları; bölüm bazında katılım yok) ve karar defteri (apartmanın tüm kararları ve Y1 sayımları, toplantı tarihi sırası, düzeltilen kayıt soluk). S3 `apartments/<apt>/reports/<yyyy>/<mm>/assembly-minutes-<toplantı>-<özet>.pdf` ve `assembly-decision-book-<özet>.pdf`, içerik özetiyle önbellekli, 5 dk imzalı link; kesinleşmemiş tutanak "taslak"
- [x] Çağrı: `POST /:id/call` alıcıları (toplantı günü oy listesindeki malikler ∩ bugün apartmanda aktif üyeliği olan kullanıcılar) `ASMCALL#<toplantı>#<sıra>` kaydına yazar, toplantı özeti ve `ASSEMBLY_CALLED` outbox olayı aynı atomik yazımda; olay kimliği `ASSEMBLY_CALLED:<toplantı>:<sıra>`. İkinci gönderim yalnızca açık `resend` + gerekçe (`assembly.call_resend`, en fazla 10). Toplantı başladıktan sonra gönderilemez; olağanüstü toplantıda 15 günden az kaldıysa uyarı (m.29/2), olağanda yönetim planı notu; ikinci toplantı ilk toplantıdan 7-15 gün sonra olmalı (plan ve ikinci toplantı kaydı 400), bildirilen plandan farklı ikinci toplantıda uyarı. Çağrıdan sonra toplantı bilgisi değişirse ayrıntıda "çağrı eskidi" uyarısı
- [x] `ASSEMBLY_CALLED` → bildirim worker'ı çağrı kaydını ve toplantıyı okur: gönderim anında üyeliği süren alıcılara "kat malikleri kurulu toplantısı" e-postası (Istanbul saatiyle tarih, yer / bağlantı, numaralı gündem, ikinci toplantı, yasal çağrının yerine geçmediği notu; düğme toplantının portal sayfasına gider); toplantı iptal edildiyse, başladıysa veya çağrıdan sonra toplantı bilgisi değiştiyse (gecikmiş / DLQ'dan yeniden sürülen teslim) kimseye gitmez. Yeni tercih kategorisi `assemblies` (anketten ayrı). SNS `notification_event_types` ve `serverless.tftest.hcl` güncellendi (**`terraform apply` gerekir**)
- [x] Sakin portalı `/api/portal/assemblies` (yalnızca aktif malik üyeliği; kiracı 403): çağrısı gönderilmiş veya kesinleşmiş toplantılar; kesinleşince yeter sayı özeti, kararlar (toplam oy / kişi / bölüm / arsa payı oranı) ve tutanak PDF'i (5 dk imzalı link)
- [x] Web: yönetici `/admin/assemblies` — formda madde başına karar türü / özel çoğunluk ve ikinci toplantı planı (7-15 gün); ayrıntıda çağrı kartı (alıcı sayısı, kullanıcısı olmayan malik, süre uyarısı, gerekçeli yeniden gönderim), bölüm bazında oy tablosu, kayıtlı oylarla dolu gerekçeli karar düzeltmesi, ilk karardan sonra kilitli katılım, tutanak kartı ve kesinleştirme, tutanak PDF'i; listede karar defteri PDF'i. Sakin `/app/genel-kurul` ve `/app/genel-kurul/:assemblyId` (menüde Oylamalar'ın yanında, "Diğer" çekmecesinde, yalnızca malik üyeliği olana görünür: oylamalar daire bazında ve kiracıya açık olabilir, genel kurul apartman geneli ve yalnızca maliklere); Hesabım bildirimlerinde "Genel kurul" konusu
- [x] Testler: `apps/api/test/assemblies-majority.test.ts` (beşte dört / üçte iki yuvarlama, payda bütün kat malikleri, kişi mi oy mu (hazır tür başına), arsa payı eksikliği, üçte bir sınırı, hisseli temsilci, oybirliğinde katılmayan), `assemblies-decisions.test.ts` (karar türü doğrulaması, bölüm bazında oy, değişmezlik ve düzeltme, tutanak / kesinleştirme, PDF önbelleği, roller, tenant izolasyonu), `assemblies-call-portal.test.ts` (olay ve alıcı kaydı, süre uyarıları, yeniden gönderim, worker alıcıları, iptal / başlamış / taşınmış toplantı, e-posta şablonu ve bağlantısı, tercih kategorisi, malik / kiracı portalı, KVKK), `assemblies-review.test.ts` (boş genel not, 7 gün alt sınırı ve plan sapması, karar sonrası katılım, kimsenin gelmediği ikinci toplantı, arsa payı eksikliğinde 422, Y1 sayımı düzeltmesi, tutanak anlık görüntüsü, denetçi / üçte iki); web `pages/admin/assemblies/schemas.test.ts`, `assemblyParts.test.tsx`, `pages/resident/assemblies/residentAssemblies.test.tsx`, `layouts/residentNav.test.ts`

**Ürün modülü — İhale / teklif toplama (`feature/ihale`)** (modül: `apps/api/src/modules/tenders/`)

- [x] İhale: iş adı, kapsam, kategori (mantolama, asansör, çatı, boya, tesisat, elektrik, peyzaj, diğer), isteğe bağlı ilgili arıza / bakım talebi (numara + başlık saklanır; KVKK: yalnızca yönetim ve denetçi görür, sakin yanıtlarında yok), asgari teklif sayısı (varsayılan 3; taslaktan çıkınca kilitlenir, yayın gerekçesi kuralı bu sayıyla), son teklif tarihi. Durumlar `draft` → `collecting` → `published` (sakinlerle paylaşıldı) → `decided`; `draft` / `collecting` / `published` → `cancelled` (gerekçeli). Silme yok; tüm yönetim işlemleri (`tender.*`) denetim kaydıyla aynı `TransactWriteItems` içinde, idempotent oluşturma (`TIDEM#`), sürümlü güncelleme. Kayıtlar: `TENDER#<id>` (teklifler kaydın içinde, en fazla 12; geri çekilenler de sayılır, silinmez), `TCMT#<id>#<zaman>#<yorum>`; yeni GSI yok
- [x] Teklif: firma, tutar (kuruş, KDV dahil / hariç + oran), geçerlilik, iş süresi (gün), garanti (ay), not ve belge. Belge gider faturası yükleme akışıyla (`tmp/{apt}/invoice-uploads/` → `apartments/{apt}/tenders/{tenderId}/quotes/{quoteId}/{uploadId}.{ext}`, PDF / görsel ≤ 10 MB, tür ve boyut S3 nesnesinden); değiştirilen belge silinmez: teklifin `documentHistory` kaydında (anahtar, ad, tarih, değiştiren; en fazla 10) kalır, denetimde eski / yeni anahtar yazılır, yönetim `GET …/document?history=<sıra>` ile aynı imzalı link yolundan açar (denetçi / sakin göremez). Geri çekme gerekçeli (silinmez, karşılaştırmaya girmez, sakinler gerekçesiyle görür). Yayından sonra teklifler donar. IAM / bucket değişikliği gerekmedi (`apartments/*`, `tmp/*` önekleri mevcut)
- [x] Karşılaştırma: KDV dahil normalize toplam (kuruş tam sayı, yarım yukarı; `net + KDV = toplam`), sıra, en düşüğe fark (kuruş + baz puan), en düşük matrah ayrıca; yayın için her aktif teklifin belgesi şart, asgari sayının altında gerekçe zorunlu ve sakinlere gösterilir. Karar: seçilen teklif + gerekçe (+ genel kurul / anket kararı için serbest referans), teklifin tutar özeti karara yazılır
- [x] Şeffaflık: sakin (bu sitede güncel üyeliği olan) ve denetçi yalnızca paylaşılmış ihaleleri görür (sonra karara bağlansa / iptal edilse de); teklif belgeleri 5 dk imzalı linkle, paylaşılmamış ihalede 404. Sorular: sakin yayındaki ihaleye kısa soru yazar (sakin başına 20), yönetim yanıtlar (ayrı geniş sınır, `tender.comment` denetim kaydı: yorum kimliği + uzunluk, metin yok); sakinler birbirinin kimliğini görmez, denetçiye de yazar kimliği maskelenir (yalnızca yönetim görür); yorum yazımı ihalenin yayında olduğunu aynı işlemde kontrol eder (`ConditionCheck`)
- [x] Web: yönetim **İhaleler** (`/admin/tenders`, durum filtresi; `/admin/tenders/:id` yan yana teklif tablosu, teklif ekle / düzenle / geri çek, belge yükleme ve canlı KDV önizlemesi, paylaş / karar / iptal diyalogları, önceki belge sürümleri, sorular; denetçi salt okur; pencereler açılıştaki ihale sürümünü gönderir, 409 sonrası aynı pencereden yeniden gönderilmez, yeniden açmak gerekir), sakin **İhaleler** (`/app/ihale`, “Diğer” çekmecesinde; ayrıntı, belgeler, karar, soru); denetim günlüğü Türkçe etiketleri
- [x] Testler: `apps/api/test/tenders.test.ts`; web `lib/tenders/model.test.ts`, `pages/admin/tenders/schemas.test.ts`, `pages/admin/tenders/dialogs.test.tsx` (409 akışı), `components/tenders/quoteComparison.test.tsx`

**Yönetim firması portföyü — çoklu apartman paneli (`feature/yonetim-portfoyu`)** (modül: `apps/api/src/modules/portfolio/`)

- [x] Model: ayrı bir "firma" kaydı **yok**. Portföy, kullanıcının bugün `apartment_manager`, `management_company` veya `observer` (salt okur) yetkisi taşıdığı apartmanların kümesidir. Mevcut veri bunu zaten taşıyor: yetkiler `APARTMENT_ROLE` kayıtlarındadır (GSI1 `USER#<sub>`), firma çalışanları da her apartmanda kendi `management_company` rol kaydını alır (Ekip daveti). `ORG#`/`TENANT` yalnızca tip olarak var, kalıcı kaydı ve personel üyeliği yok; ikinci bir yetki kaynağı açmamak için eklenmedi. Yeni DynamoDB anahtar öneki yok.
- [x] Yetki her istekte sunucuda: aktif rol portföy rolü olmalı (MFA merkezi ara katmandan), destek oturumu (`supportSessionId`) ve `platform_admin` 403. Aday apartmanlar GSI1'den (Pre Token Lambda ve `/api/me/contexts` ile aynı kaynak), sonra her biri taban `ROLE#` kaydının tutarlı okumasıyla yeniden doğrulanır: bugün biten / pasife alınan rol aynı istekte düşer; istemci apartman kimliği gönderemez
- [x] Özetler mevcut servislerden: `finance.summary(ctx, { skipSetup, accounts, units })` (Genel Bakış ile aynı; hazır hesap oluşturulmaz, bayat `FSUM#` özeti en iyi çaba geri yazılır, yazılamazsa sonuç yine döner), `reports.collection` (Genel Bakış `thisMonth` hesabı, yalnızca bu ayın `MSUM#` hareketleri); hesap ve bölüm listesi kart başına bir kez okunup özet, tahsilat ve daire sayısına verilir. `tickets.stats` (panodaki okuma, görünürlük ve SLA kuralı; durum indeksi olmadığından tüm talepler — indeksler yalnızca eklenir — sayı için eventually consistent okuma), `maintenance.stats` (Genel Bakış'ın "geciken bakım" sayısıyla aynı: görev listesinin 90 günlük penceresi `TASK_LIST_LOOKBACK_DAYS`; takvimin "geciken" listesi 1 yıl geriye bakar) + 7 gün, `equipment.expiring` (30 gün), oylama / genel kurul / ihale listeleri (ihalede denetçi yalnızca paylaşılanlar, servisin kendi kuralı)
- [x] Maliyet ve süre sınırı: sayfa başına en fazla 24 apartman (varsayılan 12, imleçli), 4 apartman eşzamanlı (zaman aşımında yuva, iptal edilemeyen okuma bitene kadar dolu kalır), apartman başına 5 sn; istek son tarihi Lambda bağlamının kalan süresi − 2,5 sn (`infra` API Lambda zaman aşımı 15 sn), Lambda dışında 10 sn. Son tarihte süren kart o anki haliyle, başlamamış apartman okunmadan döner; okunamayan bölüm yalnızca o kartta `failed` (sunucu günlüğüne apartman + bölüm + hata adı). Yetki / ad BatchGet'i işlenemeyen anahtarları üstel bekleme + jitter ile yeniden ister, kalırsa 503 + günlük satırı; sıra kararlı (ad, sonra kimlik; adsız apartman sonda). Yanıt kullanıcıya özel `private, no-cache` + ETag; web sorgusu odak dönüşünde yenilenmez ve bağlam değişiminde korunur (`['portfolio', sub]`), apartmandan geri dönünce sayfalar yeniden istenmez. Bağlam seçimi başarısız olursa da önceki apartmanın önbelleği temizlenir
- [x] Web: `/admin/portfolio` — sayfa toplamları (bu ay tahsilat oranı, vadesi geçmiş alacak, kasa + banka, açık talep / SLA, bakım, ekipman, genel kurul / oylama, ihale), ad araması, "Dikkat gerektiren" / "Eksik veri" filtresi, tahsilat oranı / vadesi geçmiş alacak / açık talebe göre sıralama, masaüstünde tablo + mobilde kart, "Daha fazla yükle". Satırdaki değerler ve "Genel Bakış" o apartmana mevcut bağlam seçimiyle (`setActiveContext`: nitelik + token yenileme) geçip ilgili ekranı açar. Menü öğesi yalnızca en az iki apartmanda portföy rolü olana (tek apartmanda Genel Bakış aynı bilgiyi verir; yönetim firması için de aynı kural), destek oturumunda gizli
- [x] Testler: `apps/api/test/portfolio.test.ts` (uygun roller, dün biten rol, GSI gecikmesi / taban kaydı, başka kullanıcı ve aday dışı kayıt, denetçi ihale sınırı, Genel Bakış / pano / görev listesi / ekipman listesiyle birebir sayılar, paylaşılan hesap / bölüm okuması ve özet geri yazımı, bölüm hatası ve süre yalıtımı, gerçek saatle Lambda kalan süresinden kısmi kartlar, zaman aşımında eşzamanlılık sınırı, BatchGet geri çekilme / 503, kararlı sıra, sayfalama / üst sınır, destek oturumu, MFA, ETag); web `pages/admin/portfolio/PortfolioPage.test.tsx` (erişilebilir ad), `context/AuthContext.test.tsx` (başarısız bağlam seçiminde önbellek), `layouts/adminNav.test.ts`

### Veri düzeltme betikleri

- `npm run backfill:expense-index -w @bm/api -- --verify` (P1-b): tüm gider kayıtlarının dizin anahtarlarını beklenen değerle karşılaştırır, hiçbir şey yazmaz; dizinsiz / uyuşmayan kayıt varsa çıkış kodu 2. Tarih aralıklı gider sorgusu (`GET /api/finance/expenses`) yalnızca dizindeki kayıtları görür.
- `npm run backfill:expense-index -w @bm/api -- --dry-run`: gider tarih dizini (GSI1 `EXPDATE#<apartmentId>`) gelmeden önce yazılmış giderlere dizin anahtarlarını ekler; gider seçicileri (sayaç dönemi faturası, talep masrafı bağlama) en yeni 200 gideri bu dizinden sınırlı sorguyla okur. Her ortamda dağıtımdan sonra bir kez; tekrar çalıştırılabilir, Scan yetkisi gerektirir (yönetici kimliği).
- `npm run backfill:finance-summary -w @bm/api -- --dry-run` (P1-a): alt cari özetlerini (`FSUM#<hesap>`) her sitenin her daire carisi için yalnızca o carinin kendi defter satırlarından üretir ve yazar. Özet türetilmiş veridir (defter TX/LE, bakiye, idempotency ve denetim zinciri değişmez); özet yoksa sistem yine doğru çalışır, betik ilk isteğin yükünü alır. `--verify` her sitede özetten üretilen aidat durumunu eski tam-defter hesabıyla karşılaştırır (uyuşmazlıkta çıkış kodu 2); `--site <id>` tek site, `--concurrency <n>` eşzamanlılık. Tekrar çalıştırılabilir (taze özet atlanır, yazım sürüm koşullu); Scan gerektirmez.
- `npm run fix:receivable-names -w @bm/api -- --dry-run` (Faz 1): adında ham daire kimliği olan eski alacak hesaplarını `Daire <no> - Kat Maliki / Kiracı/Sakin / Kat Maliki (paydaş)` biçimine çevirir. Yalnızca hesap adı (+ sürüm) değişir; defter ve geçmiş açıklamalar olduğu gibi kalır. Tekrar çalıştırılabilir, Scan yetkisi gerektirir (yönetici kimliği).

- `npm run backfill:month-summary -w @bm/api -- --dry-run` (P1-c): P1-c öncesi yazılmış (`ms` işaretsiz) işlemlerin ay/hesap toplamlarını hesaplar ve sitenin tüm defteriyle karşılaştırır; hiçbir şey yazmaz. Bayraksız çalıştırma bu toplamları `MSUM#<YYYY-MM>#<hesap>` öğelerinin ayrı eski alanlarına (`ld/lc/lp`) `SET` eder, defterle kuruşu kuruşuna eşitse siteyi `MSUMSTATE.ready` işaretler; ancak o zaman raporlar açık ayları özetten okur (fark varsa site işaretlenmez, raporlar eski doğru yolda kalır, çıkış kodu 2). `--verify` yazmadan özet ile defteri karşılaştırır; fark veya hazır olmayan site varsa çıkış kodu 2. Defter (TX/LE), bakiyeler, idempotency ve denetim zinciri değişmez; tekrar çalıştırılabilir. **Dağıtım tamamlandıktan sonra** (eski kodla çalışan Lambda kalmadığında) her ortamda bir kez.

### Sırada

> iyzico sandbox Pazaryeri yetkisi ve ilk uçtan uca ödeme doğrulaması tüm modüller tamamlandıktan sonra yapılacak (bkz. [Canlıya Geçiş Kontrol Listesi](#canlıya-geçiş-kontrol-listesi)).

**Banka — sonraki adımlar**

- [ ] Büyük dönemler için mutabakat PDF'inin rapor worker'ına taşınması (Platform aşaması; renderer saf, taşınabilir), tedarikçi avans mahsubu (Finans aşaması)
- [ ] Faz B4 — canlı ödeme aktivasyonundan sonra: online tahsilatın banka hesabına aktarım mutabakatı (aşağıda)

**Ödeme ve tahsilatın devamı**

- [ ] Online tahsilatın banka hesabına aktarım mutabakatı: sağlayıcı ekstresi ↔ `PAYOUT#` kayıtları ↔ banka hareketi otomatik eşleştirme (B4; canlı ödeme sonrası. P4/P5'te aktarım takibi, geri dönüş ve elle yeniden gönderim hazır)
- [ ] Taksit, otomatik ödeme talimatı, şifresiz ödeme linki, iade

**Finans**

- [x] Sayaç/endeks dağıtımı ve sayaç fotoğraf kanıtı (Finans 2.3, tamamlandı)
- [ ] Finans 2.2 sonrası: sakin portalından yapılandırma talebi, tedarikçi avans mahsubu

**Platform ve operasyon**

- [ ] Eski soneksiz `building-management` (prod) yığını hakkında karar ve ilk `prod` sürümü
- [ ] Abonelik / lisans (yönetim firması portföyü tamamlandı)
- [ ] Cloudflare Pages Terraform modülü
- [ ] Rapor/PDF, banka ve OCR worker'ları
- [ ] Bildirim devamı: yöneticiye toplu işlem özeti, SES geri dönüş/şikâyet olaylarının işlenmesi, SMS/WhatsApp kanalı (kategori tercihleri kanal bazlı genişletilecek)
- [ ] Genel kurul sonrası: **Hukuki yorum** listesindeki genel kurul maddelerinin avukat onayı; çağrısı gönderilmiş toplantı iptal edilince maliklere iptal e-postası; toplantı dışında alınan yazılı rızanın (m.19/2, m.44) kaydı; yönetici seçiminde aday başına ayrı öneri yerine çok adaylı oylama; yasal çağrının (imza / taahhütlü mektup) teslim takibi; çok büyük sitede (8.000+ malik kullanıcı) çağrı alıcı kaydının kovalara bölünmesi (tek öğe 400 KB sınırı)

**Performans ve ölçek (çok yıllık kullanım)**

- [x] **P1-a — finans defter okumalarının ölçeklenmesi:** tek cari işlemleri (cari kapama, avans mahsubu, yapılandırma/taksit planları, mülk/hisse devri, ters kayıt engeli, toplu geri alma önizlemesi, devir bakiyesi tespiti) yalnızca ilgili carilerin `LE#` satırlarını okur. Site geneli raporlar (Genel Bakış, `/summary`, `dues-status`, ayrılan cariler, hatırlatmalar, gecikme tazminatı kesinleştirme, dönem kapanışı tazminat uyarısı) hesap sürümüne mühürlü alt cari özetinden (`FSUM#`, `accountSummary.ts` / `accountSummaryStore.ts`) okur; özet yalnızca `Account.version` tutuyorsa kullanılır (defter yazımı sürümü aynı `TransactWriteItems` içinde artırır), bayat özet o carinin kendi satırlarından yeniden üretilir. Toplu iş ve tazminat kesinleştirmesi sonrası özetler worker'da tazelenir. Dönem kapanışı açılışı önceki kapalı ayın anlık görüntüsünden, raporlar kapalı ay yoksa canlı bakiye − (dönem başından bugüne net) ile alır; kasa/banka defteri açılışı da canlı bakiyeden. Kistelyevm hesabı `asOf`'tan bağımsız zaman çizelgesine ayrıldı (sonuç birebir aynı). Ölçek ve eşdeğerlik testleri: `finance-p1a-ledger-scaling.test.ts`. Dağıtım sonrası her ortamda bir kez `backfill:finance-summary` (önce `--verify`).
- [ ] P1-a sonrası kalan sınırlı/kademeli okumalar: banka hesabı mutabakat raporu ve tedarikçi açık kalemleri hesabın tüm `LE#` satırlarını okur (hesap bazlı, site bazlı değil); sitenin ilk dönem kapanışı açılışı tek seferlik tüm geçmişten hesaplar
- [x] **P1-b — gider tarih dizini ve sayaç dönemi büyük ölçeği:** `GET /api/finance/expenses?from&to&limit&cursor&order` (GSI1 tarih dizini, sayfalı); Hareketler'in Gelir / Gider sekmesi sunucuda `?category=income|expense` ile yalnızca kasa/banka satırlarından okunur (tahakkuklar taranmaz); `backfill:expense-index --verify`. Sayaç dönemi toplu geri alma 60+ kalemde `202` + `meter_reversal` arka plan işi (parça parça, satır durumu her parçada yazılır); onay ve geri almada kalem başına geçici hata yeniden denemesi; denetimsiz atomik yazımlarda da `TransactionConflict` üstel bekleme + jitter ile yeniden denenir (sayaç deposu artık çekişmeyi 409'a çevirmiyor); borçlu çözümlemesi hesapları / hisseli bölümleri tek sorguyla okur; geri alma önizlemesinde sayaç ve hesap okumaları sınırlı eşzamanlılıkla. `GET /api/metering/periods/:id/job` ile sayfa yenilense de süren iş izlenir. Testler: `p1b-expense-meters-scaling.test.ts`.
- [x] **P1-c — açık ayların hesap-ay hareket özeti:** her defter yazımı aynı `TransactWriteItems` içinde (ay, hesap) başına `MSUM#<YYYY-MM>#<hesap>` öğesine koşulsuz `ADD` ile borç/alacak/tahsilat kuruşlarını ekler (append-only defter, idempotency ve denetim zinciri değişmez; işlem kaydı `ms: 1` ile işaretlenir). Mizan, gelir-gider, bütçe-gerçekleşen ve Genel Bakış açık ayları özetten okur (kapalı aylar yine anlık görüntüden); sitenin özeti hazır değilse (`MSUMSTATE`) eski tam tarama yoluna düşer, sonuç aynı. Yeni siteler özetle doğar; mevcutlar için `backfill:month-summary` (`--dry-run`, `--verify`). Sayaç geri alma işi kimliği dönem önekli (`mr-<dönem>-…`): worker başlamadan sayfa yenilense de iş bulunur; `BulkJobProgress` geri alma için "X ters kayıt işlendi." gösterir; `/calculate` bölümleri ikinci kez okumaz. Testler: `p1c-month-summary.test.ts` (1.200 bölüm × 3 açık ay).
- [ ] Büyük sitede (1.000+ bölüm) sayaç önizlemesi (`/calculate`) hâlâ senkron: canlı ölçüm ve gerekirse arka plan işine alma
- [ ] Genel Bakış / bütçe gerçekleşen / gelir-gider raporu açık (kapanmamış) ayların tüm hareketlerini okur (kapalı aylar anlık görüntüden): aylık kapanış yapılmayan büyük sitede hesap-ay hareket özeti (rollup) değerlendirilmeli
- [ ] Gece denetimi (`ledger_audit`) tüm siteleri tek Lambda çağrısında sırayla tarar: süre metriği / alarmı ve site başına mesaja bölme
- [x] PWA: `manifest.webmanifest` (YÖNESİST adı, logo ikonları, maskable ikon), `public/sw.js` (yalnızca aynı kökenli GET; sayfa geçişi önce ağ + çevrimdışı kabuk, `/assets/*` önbellek) ve production'da kayıt (`src/lib/pwa.ts`)

**Ürün modülleri (onaylı sıra: O1 sonrası)**

- [ ] Güvenlik kapısı devamı: IP başına sınır (G3 alan adı / Cloudflare ile), araç listesinde taşınma nedeninin gösterimi (ortak `VehicleList`), denetim ekranında `gate.*` eylem etiketleri, taşınma kaydedilince (bitiş tarihi geçmişse) gece taramasını beklemeden anında pasife alma
- [ ] İhale devamı: ihale başına birden fazla geçerli gider (hakediş), tedarikçi (vadeli borç) hesabıyla firma eşleştirmesi, genel kurul kararının (`reference`) gerçek bağlantıya dönüşmesi, ihale yorumlarında yönetim moderasyonu ve yanıtın belirli bir soruya bağlanması
- [ ] Abonelik / lisans
- [ ] Portföy devamı: tüm sayfalar yüklenmeden portföy geneli toplam (sunucuda apartman başına özet önbelleği veya arka plan toplama), portföyde sunucu tarafı ad araması, firma (`ORG#`) kaydı ve firma çalışanı yönetimi gerekirse ayrı bir yetki modeli
- [ ] Otomasyon / kanallar: SMS / WhatsApp, rapor / OCR worker'ları

**Güvenlik sertleştirmesi (G3 alan adına bağlı, beklemede)**

- [ ] Denetim günlüğü devamı: S3 Object Lock (WORM) dışa aktarım
- [x] MFA: prod için `enforce` (`prod.tfvars` + korkuluk); `dev` `warn`'da kalır
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

- [ ] **Alan adı (planlanan, henüz alınmadı):** `yonetimsistemim.com` satın alınacak; ardından Cloudflare Pages prod projesine `app.yonetimsistemim.com` bağlanır ve `infra/prod.tfvars` → `custom_domain` satırı açılır.
- [ ] **İlk prod dağıtımı:** [`infra/PROD_DEPLOY.md`](infra/PROD_DEPLOY.md) — eski soneksiz prod yığını için önce yalnızca plan (destroy / replace satırları incelenir), `production` environment onaylayıcısı, `ALERT_EMAIL`, prod Pages projesi (`prod.tfvars`'taki `pages.dev` adresi yer tutucudur), ilk `v*` etiketi.
- [ ] **SNS alarm aboneliği onayı:** İlk apply'dan sonra `ALERT_EMAIL` kutusuna gelen onay bağlantısı tıklanır; `aws sns list-subscriptions-by-topic` ile `PendingConfirmation` olmadığı doğrulanır, test alarmıyla teslim denenir.
- [ ] **Davet e-postası kapasitesi:** SES bağlanana kadar Cognito `COGNITO_DEFAULT` ile günde yaklaşık 50 e-posta gönderir; 300+ sakinli pilot sitede toplu davet için SES zorunludur.
- [ ] **Gider tarih dizini:** Her ortamda dağıtımdan sonra bir kez `npm run backfill:expense-index -w @bm/api`.
- [ ] **Gider tarih dizini doğrulaması (P1-b):** Her ortamda dağıtımdan sonra `npm run backfill:expense-index -w @bm/api -- --verify` (dizinsiz / uyuşmayan 0 olmalı; değilse `backfill:expense-index` çalıştırılır).
- [ ] **Hesap-ay özeti (P1-c):** Dağıtım tamamlandıktan sonra her ortamda `npm run backfill:month-summary -w @bm/api -- --dry-run`, ardından bayraksız, en son `--verify` (uyuşmazlık ve hazır olmayan site 0 olmalı).
- [ ] **Alt cari özetleri (P1-a):** Her ortamda dağıtımdan sonra bir kez `npm run backfill:finance-summary -w @bm/api -- --verify` (uyuşmazlık raporu boş olmalı), ardından `--verify` olmadan da çalıştırılabilir.

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
