## Özet

Serverless backend çekirdeği (Faz 1–5): modüler monolit API, Cognito tabanlı çoklu apartman yetkilendirmesi, append-only finansal defter, sakin portalı, bildirim worker'ı ve tüm yığının Terraform + GitHub Actions ile dağıtımı.

`feature/aws-entegrasyonu` → `main` · 8 commit · 66 dosya · +15.195 / −3

> ⚠️ `main`'e merge edildiğinde `serverless-deploy.yml` **`terraform apply` çalıştırır** ve yığın production ortamına kurulur.

## Kapsam

| Faz | Commit | İçerik |
| --- | --- | --- |
| 1 | `8696607` | DynamoDB yardımcıları (single-table, koşullu yazım), Core modülü (site / blok / bağımsız bölüm), JWT doğrulama |
| 2 | `143d111` | Çift taraflı defter, toplu aidat tahakkuku (eşit / m² / arsa payı), tahsilat, gider, ters kayıt, makbuz |
| 3 | `ff6d260` | Sakin portalı uçları, SNS/EventBridge olay yayıncısı |
| 3 | `8dc9e6f` | Üyelik (malik / kiracı) ve duyuru yönetimi |
| 4 | `aa0f4cd` | Serverless Terraform yığını (API Gateway, Lambda, DynamoDB, Cognito, SNS/SQS), Lambda ESM build, `terraform test` |
| 5 | `16bc212` | CI/CD pipeline, bildirim worker'ı, apartman rol yönetimi, `seed:admin` bootstrap betiği |
| — | `31e855d` | `terraform test`: plan aşamasında SQS ARN'i için `override_resource` (known-after-apply hatası) |
| — | `e5542b2` | README |

## İncelemede özellikle bakılması gerekenler

### 1. Tenant izolasyonu ve kimlik
- `apps/api/src/auth/preTokenGeneration.ts`: `custom:active_apartment` / `custom:active_role` istemci tarafından yazılabilir. Claim yalnızca DynamoDB'de aktif üyelik varsa üretiliyor mu? İstemcinin gönderdiği aynı adlı claim'ler bastırılıyor mu?
- `apps/api/src/auth/authenticators.ts`: `AUTH_MODE=mock` production/Lambda ortamında gerçekten reddediliyor mu? Varsayılan mod `deny` mı?
- Handler'lar `apartmentId`'yi istek gövdesinden değil, yalnızca JWT claim'inden mi alıyor?

### 2. Finansal defter
- `apps/api/src/modules/finance/`: Defter kayıtlarında UPDATE/DELETE yolu yok mu, düzeltmeler yalnızca ters kayıtla mı?
- Tutarlar kuruş cinsinden integer mı; `distributeKurus` (BigInt, en büyük kalan yöntemi) toplamı birebir koruyor mu?
- Tahakkuk + bakiye güncellemesi `TransactWriteItems` ile atomik mi; tekrar eden istekler idempotency parmak izi ve `attribute_not_exists` ile etkisiz kalıyor mu?

### 3. Altyapı ve güvenlik
- `infra/*.tf`: IAM politikaları en az yetki ilkesine uygun mu (her Lambda'nın kendi rolü, kaynak bazlı ARN'ler)?
- DynamoDB PITR ve silme koruması prod'da açık mı; `GET /api/health` dışındaki tüm rotalar JWT authorizer arkasında mı?
- SQS görünürlük zaman aşımı worker süresinin 6 katı mı, DLQ ve alarmlar bağlı mı?

### 4. CI/CD
- `apply` yalnızca `main` push'unda ve `production` environment onayıyla mı çalışıyor?
- AWS erişimi OIDC (`AWS_DEPLOY_ROLE_ARN`) ile mi; uzun ömürlü anahtar kullanılıyor mu?

## Test

- API: Vitest (`npm test -w @bm/api`), `aws-sdk-client-mock` ile
- Altyapı: `terraform -chdir=infra test` (mock provider, AWS kimlik bilgisi gerektirmez)
- CI: typecheck, test, `build:lambda`, `terraform fmt` / `validate` / `test`

## Merge öncesi yapılacaklar

- [ ] `test-mcp.txt` ve `apps/api/Claude outputs/` silinsin (yanlışlıkla eklenmiş; ikincisi workflow dosyasının bir kopyası)
- [ ] Repo variable'ları tanımlı olsun: `AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`, `ALERT_EMAIL`, `CORS_ALLOW_ORIGINS`
- [ ] Terraform state bucket'ı ve `production` environment koruma kuralları hazır olsun
- [ ] CI yeşil

## Merge sonrası

- [ ] Deploy sonrası `GET /api/health` kontrolü
- [ ] `npm run seed:admin` ile ilk yönetici ve test sitesi

## Bilinen sınırlamalar (bu PR'ın kapsamı dışında)

- **Transactional outbox yok** (`events/publisher.ts` TODO): Defter yazıldıktan sonra olay yayını başarısız olursa olay kaybolabilir.
- **Portal ölçeği** (`portal/repository.ts` TODO): Büyük sitelerde `unitId` GSI'ı gerekecek.
- **Eksik özellikler:** Kıstelyevm hesaplaması, S3 / pre-signed URL, ödeme entegrasyonu, EventBridge Scheduler, WAF, audit log henüz yok.
- **Frontend iskelet halinde:** Ekranlar sonraki fazda yapılacak.
- **Eski dağıtım yolları:** `infra/ec2`, `infra/hello-lambda` ve ilgili workflow'lar hâlâ duruyor; ayrı bir PR'da kaldırılabilir.
