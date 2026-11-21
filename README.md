# Building Management — Dijital Site ve Aidat Yönetim Sistemi

Türkiye'deki apartman, site ve profesyonel yönetim firmaları için çok kiracılı (multi-tenant), sunucusuz bir site ve aidat yönetim platformu. Kat Mülkiyeti Kanunu'na uygun alt cari (malik / kiracı) ayrımı, dağıtım anahtarlarıyla toplu tahakkuk ve değişmez (append-only) finansal defter üzerine kuruludur.

> **Durum (20.11.2026):** Aktif geliştirme. Backend çekirdeği, yönetici ve sakin web ekranları, kıstelyevm, belge deposu ve toplu aktarım `main` dalında; `dev` ortamı AWS `eu-north-1` bölgesinde, web Cloudflare Pages üzerinde canlı. Online ödeme (Adım 8b: iyzico Pazaryeri altyapısı, ekranlar, inceleme/iade aracı) `main`'e alındı ve `dev`'de çalışıyor; iyzico sandbox uçtan uca doğrulaması bilerek proje sonuna bırakıldı ([Canlıya Geçiş Kontrol Listesi](#canlıya-geçiş-kontrol-listesi)). Ayrıntılar için [Yol Haritası](#yol-haritası).

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
| `OUTBOX_LOCAL_RELAY` | Yerel sunucuda `off` ise bekleyen outbox kayıtlarını yoklayan bellek içi relay çalışmaz. |

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

Önemli değişkenler: `environment` (`prod` / `staging`), `alert_email`, `cors_allow_origins`, `cognito_user_pool_tier` (`LITE` / `ESSENTIALS`), `ses_identity_arn`, `ses_from_address`, `api_throttle_rate_limit`, `api_throttle_burst_limit`.

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
| `me` | `/api/me` | Oturum sahibinin seçebileceği apartman/rol bağlamları (`GET /contexts`). **Rol claim'i gerektirmez**: bağlam seçilmeden önce de çalışır |
| `core` | `/api/sites` | Site, blok ve bağımsız bölüm (daire/dükkan) yönetimi; m², arsa payı, sayaç kuralları |
| `finance` | `/api/finance` | Hesaplar, toplu aidat tahakkuku, tahsilat, gider, ters kayıt, bakiye; raporlar: `GET /summary`, `/dues-status` (FIFO gecikme), `/transactions` (sayfalı), `/former-accounts` (ayrılan sakin carileri). Taşınmada cari kapama: `GET /units/:unitId/closures/preview`, `GET\|POST /units/:unitId/closures`, `GET /closures/:closureId`, `POST /closures/:closureId/reverse` |
| `memberships` | `/api/memberships` | Kullanıcı–daire bağlantıları (malik / kiracı) |
| `residents` | `/api/residents` | Apartmanın kişileri (ad / e-posta, denetçiye maskeli) ve `POST /invite`: e-postayla Cognito kullanıcısı bul/oluştur + üyelik ata |
| `apartment-roles` | `/api/apartment-roles` | Apartman bazlı personel ve yönetici rolleri |
| `announcements` | `/api/announcements` | Duyuru oluşturma, onay, arşiv |
| `portal` | `/api/portal` | Sakin ekranı: `my-unit`, `my-dues`, `my-statement`, `my-receipts`, duyurular |

---

## Roller ve Yetkilendirme

Yedi rol: `platform_admin`, `management_company`, `apartment_manager`, `resident`, `building_staff`, `security_guard`, `observer` (salt-okunur).

- Apartman bazlı roller Cognito gruplarında değil, DynamoDB `Membership` kayıtlarında tutulur. Cognito grubu yalnızca `platform_admin` için kullanılır.
- Kullanıcı aktif apartmanı seçtiğinde **Pre Token Generation Lambda** access token'a `apartmentId`, `role` (ve varsa `organizationId`) claim'lerini ekler.
- Handler'lar tenant izolasyonunu istek gövdesinden değil, **JWT claim'lerinden** yapar.

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

**Finans — taşınmada cari kapama ve borç devri (`feature/finans-cari-devri`)**

- [x] Alt cari yorumlayıcısı: kesim tarihli cari, devir kalemleri vade ve tazminat başlangıcıyla taşınır; FIFO mahsup ve kıstelyevm tek kaynaktan (`subledger.ts`)
- [x] Kapama servisi ve API: önizleme, tek atomik yazım (tazminat kesinleştirme + devir/iade + kapama kaydı + üyelik bitişi), `closedThrough` kilidi, idempotency, güvenli geri alma
- [x] Ayrılan sakin carisinden tahsilat (`accountId`), ayrılan cariler raporu ve özet; ayrılan carinin tazminatı işlemeye devam eder; yeni sakinin portalı, makbuzları, online ödemesi ve bildirimleri eskisinden ayrı
- [x] Web: Daireler → "Taşınma" sihirbazı (kim/tarih → önizleme → borç & avans kararı → gerekçe/onay → yeni sakin daveti), kapama geçmişi ve "Geri al"; Finans → "Ayrılan cariler" sekmesi, tahsilatta cari seçimi ve "Tahsilat al" kısayolu
- [x] Boş daire kuralı: oturan yoksa sakin gideri kat malikine (tekil, toplu ve otomatik tahakkuk; önizleme ve bildirim dahil)

### Sırada

> iyzico sandbox Pazaryeri yetkisi ve ilk uçtan uca ödeme doğrulaması tüm modüller tamamlandıktan sonra yapılacak (bkz. [Canlıya Geçiş Kontrol Listesi](#canlıya-geçiş-kontrol-listesi)).

**Ödeme ve tahsilatın devamı**

- [ ] Online tahsilatın banka hesabına aktarım (settlement) mutabakatı
- [ ] Taksit, otomatik ödeme talimatı, şifresiz ödeme linki, iade
- [ ] Banka hareketi eşleştirme

**Finans**

- [x] Taşınmada cari kapama ve eski/yeni kiracı borç devri (bkz. Tamamlanan → Finans — taşınmada cari kapama)
- [ ] Sayaç/endeks dağıtımı ve sayaç görselleri
- [ ] Avans mahsubu, borç yapılandırma, mülk devri, hisseli mülkiyet
- [ ] Dönem kapama, bütçe / yıllık işletme projesi

**Platform ve operasyon**

- [ ] Eski soneksiz `building-management` (prod) yığını hakkında karar ve ilk `prod` sürümü
- [ ] Güvenilir olay ve bildirim hattı (`feature/outbox-bildirim`): ~~1. outbox'a atomik yazım~~ ✓ · ~~2. Streams relay~~ ✓ · ~~3. `outbox_sweep` (5 dk) + `ledger_audit` (03:40, salt okunur)~~ ✓ · 4. SES e-posta kanalı
- [ ] Arıza/görev, ziyaretçi QR, anket/oylama, rezervasyon, ihale
- [ ] Yönetim firması portföyü, abonelik/lisans
- [ ] Özel alan adı + Cloudflare WAF (HTTP API'ye AWS WAF bağlanamaz), Cloudflare Pages Terraform modülü, audit log
- [ ] Rapor/PDF, banka ve OCR worker'ları

### Canlıya Geçiş Kontrol Listesi

Bilinen, bilerek ertelenmiş adımlar:

- [ ] iyzico Sandbox hesabındaki (Üye İşyeri No: `3438668`) Pazaryeri (Marketplace / SubMerchant) yetki başvurusu ve test kartıyla ilk uçtan uca online ödeme doğrulaması, projenin tüm modülleri tamamlandıktan sonra hayata geçirilecektir. Yetki açılana kadar alt üye işyeri kaydı `provider_rejected` döner; doğrulamada `paymentStatus` / `fraudStatus` eşlemeleri ve webhook imzası da kontrol edilecektir.
- [ ] Aynı sandbox doğrulamasında iade akışı: Checkout Form sonucundaki `itemTransactions[].paymentTransactionId` alanı, `/payment/refund` yanıtı, raporlama servisinde (`GET /v2/reporting/payment/details`) başarılı iadenin `refundStatus = 1` olduğu varsayımı ve GET isteğinde sorgu dizgisinin IYZWSv2 imzasına katılmadığı varsayımı kontrol edilecektir.

---

## Lisans

Özel (private) proje. Tüm hakları saklıdır.
