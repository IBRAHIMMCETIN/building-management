# Building Management — Dijital Site ve Aidat Yönetim Sistemi

Türkiye'deki apartman, site ve profesyonel yönetim firmaları için çok kiracılı (multi-tenant), sunucusuz bir site ve aidat yönetim platformu. Kat Mülkiyeti Kanunu'na uygun alt cari (malik / kiracı) ayrımı, dağıtım anahtarlarıyla toplu tahakkuk ve değişmez (append-only) finansal defter üzerine kuruludur.

> **Durum (21.11.2026):** Aktif geliştirme. Backend çekirdeği, yönetici ve sakin web ekranları, kıstelyevm, belge deposu ve toplu aktarım `main` dalında; `dev` ortamı AWS `eu-north-1` bölgesinde, web Cloudflare Pages üzerinde canlı. Online ödeme (Adım 8b: iyzico Pazaryeri altyapısı, ekranlar, inceleme/iade aracı), taşınmada cari kapama / borç devri ve güvenilir olay ve bildirim hattı (transactional outbox, Streams relay, süpürücü, gecelik defter denetimi, SES e-posta kanalı) `main`'e alındı. Bildirimler alan adı alınana kadar `log` modunda; iyzico sandbox uçtan uca doğrulaması ve SES aktivasyonu bilerek canlıya geçişe bırakıldı ([Canlıya Geçiş Kontrol Listesi](#canlıya-geçiş-kontrol-listesi)). Sıradaki iş: güvenlik sertleştirmesi. Ayrıntılar için [Yol Haritası](#yol-haritası).

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
| `PAYMENTS_POS_RATE_BPS` / `PAYMENTS_POS_FIXED_FEE_KURUS` | Online ödeme sağlayıcısının sözleşme komisyonu: oran baz puan (`249` = %2,49; 0-1000) ve işlem başı sabit ücret kuruş (`25` = 0,25 TL; 0-5000). Varsayılan `0`; geçersiz değer başlangıçta hata verir. Komisyon tahmininde kullanılır, ödeme hesabı bazında geçersiz kılınabilir (Terraform `payments_pos_rate_bps`, `payments_pos_fixed_fee_kurus`). |
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
| `operations.tf` | Platform alarmları (EMF özel metrikleri, `BuildingManagement` / `Stack`): `LedgerDrift` (gecelik defter denetimi sapması), `OutboxSweepFailed`, `OutboxOldestPendingSeconds` |
| `audit.tf` | Değiştirilemez denetim tablosu (yalnızca ekleme; güncelleme/silme IAM ve kaynak politikasında reddedilir), 10 yıl TTL, PITR |
| `security_monitoring.tf` | Hassas uçlar için ayrı JWT rotaları + rota bazlı throttling; giriş hatası, MFA, API 5xx, denetim zinciri ve gece denetimi alarmları (bkz. [Güvenlik ve izleme](#güvenlik-ve-izleme)) |

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
| `finance` | `/api/finance` | Hesaplar, toplu aidat tahakkuku, tahsilat, gider, ters kayıt, bakiye; raporlar: `GET /summary`, `/dues-status` (FIFO gecikme), `/transactions` (sayfalı), `/former-accounts` (ayrılan sakin carileri). Taşınmada cari kapama: `GET /units/:unitId/closures/preview`, `GET\|POST /units/:unitId/closures`, `GET /closures/:closureId`, `POST /closures/:closureId/reverse` |
| `memberships` | `/api/memberships` | Kullanıcı–daire bağlantıları (malik / kiracı) |
| `residents` | `/api/residents` | Apartmanın kişileri (ad / e-posta, denetçiye maskeli) ve `POST /invite`: e-postayla Cognito kullanıcısı bul/oluştur + üyelik ata |
| `apartment-roles` | `/api/apartment-roles` | Apartman bazlı personel ve yönetici rolleri |
| `announcements` | `/api/announcements` | Duyuru oluşturma, onay, arşiv |
| `portal` | `/api/portal` | Sakin ekranı: `my-unit`, `my-dues`, `my-statement`, `my-receipts`, duyurular |
| `audit` | `/api/audit` | Denetim günlüğü, salt okunur: en yeni önce, `limit` (≤100), `cursor`, `from`/`to`, `action` öneki, `actorId`. Varsayılan kapsam JWT'deki apartman (`apartment_manager`, `management_company`, `observer`; `platform_admin` yalnızca destek oturumuyla); `?scope=platform` yalnızca doğrudan `platform_admin` (platform zinciri). Yanıt hash'e giren tüm alanları içerir (tarayıcıda doğrulama). `GET /integrity?scope=`: gece doğrulamasının durumu (`verified` / `pending` / `stale` / `empty`) |
| `mfa` | `/api/mfa` | `GET /users/:userId` (MFA ve hesap durumu, `canReset` / `blockedReason`; sıfırlamayla aynı yetki kuralları), `GET /users?email=` (yalnızca `platform_admin`), `POST /users/:userId/reset` `{ reason }` (10-500 karakter): cihaz kaybında TOTP'yi kapatır ve tüm oturumları düşürür; önce denetim günlüğüne yazılır. `platform_admin` herkes için; `apartment_manager` / `management_company` yalnızca kendi apartmanındaki, başka apartmanda yönetici/denetçi olmayan ve `platform_admin` olmayan kullanıcılar için. Kendi MFA'sı ve destek oturumu ile yapılamaz |
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
| `POST /api/residents/invite`, `POST /api/finance/dues`, `POST /api/imports` | 2/sn, 5 | `bulk_write_route_rate_limit`, `bulk_write_route_burst_limit` |
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
- **Dağıtım anahtarları:** Eşit, m², arsa payı.
- **Atomiklik ve idempotency:** Çoklu kayıtlar `TransactWriteItems` ile yazılır; tekrar gelen istekler parmak izi + `attribute_not_exists` koşullu yazımla etkisiz kalır.
- **Defter denetimi:** Her gece `ledger_audit` hesap bakiyelerini `LE#` toplamlarıyla, işlem dengesini, kapama kilidini, makbuz sayacını ve tamamlanmış online ödemelerin defter kaydını karşılaştırır. Sapma otomatik düzeltilmez; yalnızca platform alarmı üretir (düzeltme ters kayıtla).
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

### Sırada

> iyzico sandbox Pazaryeri yetkisi ve ilk uçtan uca ödeme doğrulaması tüm modüller tamamlandıktan sonra yapılacak (bkz. [Canlıya Geçiş Kontrol Listesi](#canlıya-geçiş-kontrol-listesi)).

**Ödeme ve tahsilatın devamı**

- [ ] Online tahsilatın banka hesabına aktarım (settlement) mutabakatı
- [ ] Taksit, otomatik ödeme talimatı, şifresiz ödeme linki, iade
- [ ] Banka hareketi eşleştirme

**Finans**

- [ ] Sayaç/endeks dağıtımı ve sayaç görselleri
- [ ] Avans mahsubu, borç yapılandırma, mülk devri, hisseli mülkiyet
- [ ] Dönem kapama, bütçe / yıllık işletme projesi

**Platform ve operasyon**

- [ ] Eski soneksiz `building-management` (prod) yığını hakkında karar ve ilk `prod` sürümü
- [ ] Arıza/görev, ziyaretçi QR, anket/oylama, rezervasyon, ihale
- [ ] Yönetim firması portföyü, abonelik/lisans
- [ ] Cloudflare Pages Terraform modülü
- [ ] Rapor/PDF, banka ve OCR worker'ları
- [ ] Bildirim devamı: web'de tercih ekranı, yöneticiye toplu işlem özeti, SES geri dönüş/şikâyet olaylarının işlenmesi, SMS/WhatsApp kanalı

**Güvenlik sertleştirmesi (sıradaki iş: G3, alan adına bağlı)**

- [ ] Denetim günlüğü devamı: S3 Object Lock (WORM) dışa aktarım
- [ ] MFA devamı: `warn` → `enforce` geçişinin ortam bazında planlanması
- [ ] G3 — Uç koruma (alan adı alındığında): API özel alan adı Cloudflare arkasında, WAF ve oran sınırlama, `disable_execute_api_endpoint`, kaynak doğrulama (HTTP API'ye AWS WAF bağlanamaz; CloudFront WAF'ı hesap SCP'si nedeniyle kullanılamaz)

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
- [ ] Aynı sandbox doğrulamasında iade akışı: Checkout Form sonucundaki `itemTransactions[].paymentTransactionId` alanı, `/payment/refund` yanıtı, raporlama servisinde (`GET /v2/reporting/payment/details`) başarılı iadenin `refundStatus = 1` olduğu varsayımı ve GET isteğinde sorgu dizgisinin IYZWSv2 imzasına katılmadığı varsayımı kontrol edilecektir.

---

## Lisans

Özel (private) proje. Tüm hakları saklıdır.
