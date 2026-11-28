# Runbook — DynamoDB Point-in-Time Recovery (PITR) geri dönüş tatbikatı

> Adım 2-5 (28.11.2026). Kapsam: ana tablo (`building-management-<ortam>`) ve değiştirilemez denetim tablosu (`…-audit`). İkisinde de PITR ve silme koruması açık (`infra/dynamodb.tf`, `infra/audit.tf`). PITR son **35 güne** kadar herhangi bir saniyeye geri yükler.
>
> **Altın kural:** PITR geri yüklemesi **yeni bir tablo** oluşturur; çalışan tabloya asla doğrudan yazılmaz. Defter append-only olduğundan kayıp/bozulma düzeltmesi önce yeni tabloda doğrulanır, sonra trafik bilinçli olarak yönlendirilir.

## 1. Ne zaman kullanılır

| Durum | Yol |
| --- | --- |
| Yanlış betik / hatalı dağıtım çok sayıda kaydı bozdu | PITR → yeni tablo → doğrulama → geçiş (bu runbook, §4) |
| Tek tük hatalı muhasebe kaydı | **PITR değil**: ters kayıt (append-only kural) |
| Bölge / hesap kaybı | Bu runbook kapsamı dışında (yedek bölge yok; ileride) |
| Tatbikat (önerilen: çeyrekte bir, dev'de) | §3 — geri yükle, doğrula, geçiş yapmadan sil |

## 2. Hazırlık

- AWS kimliği: yönetici rolü (`aws login`), bölge **eu-north-1** (hesap SCP'si diğer bölgeleri reddeder).
- Değişkenler (PowerShell):

```powershell
$env:AWS_REGION = "eu-north-1"
$SRC   = terraform -chdir=infra output -raw dynamodb_table_name      # ör. building-management-dev
$AUDIT = terraform -chdir=infra output -raw audit_table_name
$STAMP = Get-Date -Format "yyyyMMdd-HHmm"
$DST   = "$SRC-restore-$STAMP"
$DSTA  = "$AUDIT-restore-$STAMP"
```

- PITR penceresini kontrol edin:

```powershell
aws dynamodb describe-continuous-backups --table-name $SRC `
  --query "ContinuousBackupsDescription.PointInTimeRecoveryDescription"
# EarliestRestorableDateTime .. LatestRestorableDateTime arasinda bir an secin
```

- Geri dönülecek anı **UTC** olarak belirleyin (olaydan hemen önce; CloudWatch/Lambda loglarında ilk hatalı yazımın zamanı). Örnek: `2026-11-28T07:59:00Z`.

## 3. Geri yükleme (yeni tabloya)

Ana tablo ve denetim tablosu **aynı ana** geri yüklenmelidir (defter ile denetim zinciri aynı atomik yazımlarla birlikte ilerler).

```powershell
$AT = "2026-11-28T07:59:00Z"

aws dynamodb restore-table-to-point-in-time `
  --source-table-name $SRC --target-table-name $DST `
  --restore-date-time $AT `
  --billing-mode-override PAY_PER_REQUEST `
  --sse-specification-override Enabled=true

aws dynamodb restore-table-to-point-in-time `
  --source-table-name $AUDIT --target-table-name $DSTA `
  --restore-date-time $AT `
  --billing-mode-override PAY_PER_REQUEST `
  --sse-specification-override Enabled=true

aws dynamodb wait table-exists --table-name $DST
aws dynamodb wait table-exists --table-name $DSTA
aws dynamodb describe-table --table-name $DST --query "Table.[TableStatus,ItemCount,GlobalSecondaryIndexes[0].IndexStatus]"
```

Notlar:
- Geri yüklenen tabloya **taşınmayanlar**: Streams, TTL, PITR, silme koruması, etiketler, otomatik ölçekleme. GSI1 geri yüklenir (projeksiyon ALL). Süre tablo boyutuna bağlıdır (dev'de dakikalar).
- Geri yüklenen tablo **Terraform state'inde değildir**; doğrulama için doğrudan adıyla kullanılır.

## 4. Bütünlük doğrulaması (yeni tablo üzerinde)

Tüm betikler **salt okunur `--verify`** modunda çalıştırılır (yazmaz; uyuşmazlıkta çıkış kodu 2). `DYNAMODB_TABLE_NAME` geri yüklenen tabloyu gösterir.

```powershell
$env:DYNAMODB_TABLE_NAME = $DST
$env:AUDIT_TABLE_NAME    = $DSTA

# 1) Gider tarih dizini (P1-b): tüm giderler dizinde ve doğru anahtarla
npm run backfill:expense-index -w @bm/api -- --verify

# 2) Alt cari özetleri (P1-a): özetten üretilen aidat durumu = tam defter hesabı
npm run backfill:finance-summary -w @bm/api -- --verify

# 3) Hesap-ay özeti (P1-c): MSUM = defter (kuruş kuruş); hazır olmayan site listelenir
npm run backfill:month-summary -w @bm/api -- --verify

# 4) Daire makbuz dizini (Adım 2-1): her dairede dizin = eski tam tarama (kuruş)
npm run backfill:unit-payments -w @bm/api -- --verify
```

Ardından **gece denetimini** geri yüklenen tabloya karşı tek site için elle çalıştırın (defter dengesi, hesap bakiyeleri = satır toplamları, kapama kilidi, online ödeme tutarlılığı, denetim zinciri hash'leri):

```powershell
# Yerel: scheduler worker'ı geri yüklenen tablolarla, tek site mesajıyla
$env:EVENTS_MODE = "none"
npx -w @bm/api tsx -e "import('./src/workers/scheduler-worker.ts').then(async (m) => { const r = await m.handler({ Records: [{ messageId: 'pitr', body: JSON.stringify({ job: 'ledger_audit', scheduledTime: new Date().toISOString(), apartmentId: process.env.SITE }) }] }); console.log(JSON.stringify(r)); })"
# beklenen: batchItemFailures: [] ve logda msg=ledger_audit, findings: [] (her site için SITE ortam değişkeniyle tekrarlayın)
```

Kabul ölçütleri (hepsi sağlanmadan geçiş yapılmaz):

- [ ] Dört `--verify` betiği çıkış kodu **0**
- [ ] Her site için `ledger_audit` bulgusu **0** (`LedgerDrift = 0`, `AuditChainBroken = 0`)
- [ ] Rastgele 5 daire için portal borç/makbuz ekranı geri dönülen anın beklenen değerleriyle aynı (dev'de API'yi `DYNAMODB_TABLE_NAME=$DST` ile yerelde çalıştırarak)
- [ ] Olay anından sonra yazılmış meşru kayıtların listesi çıkarıldı (§5)

## 5. Olay sonrası meşru yazımlar

Geri dönülen andan sonra yapılan **doğru** işlemler (tahsilat, banka eşleştirme, online ödeme) yeni tabloda yoktur. Kaynak tablodan bulunur ve uygulamanın kendi uçlarıyla (aynı idempotency anahtarlarıyla) yeniden girilir; doğrudan kopyalanmaz:

- Kaynak tabloda `TX#<olay günü>` sonrası işlemler: `GET /api/finance/transactions?from=<gün>` (eski tablo ile çalışan API).
- Online ödemeler: sağlayıcı paneli + `payment_reconcile` (niyetler sağlayıcıdan yeniden sorgulanır).
- Banka hareketleri: ekstre yeniden yüklenir (satır kimlikleri içerikten türetildiği için tekrar oluşmaz).

## 6. Geçiş (yalnızca gerçek olayda)

1. Bakım penceresi: `scheduler_enabled = false` (zamanlanmış işler durur), web'de bakım duyurusu.
2. Terraform ile tablo adını değiştirmek yerine **önerilen yol**: geri yüklenen tablodan kaynak tabloya veri taşımak değil, uygulamayı yeni tabloya yönlendirmek için `DYNAMODB_TABLE_NAME` / `AUDIT_TABLE_NAME` Lambda ortam değişkenlerini geçici olarak güncellemek (API, worker'lar, Pre Token). Kalıcı çözüm için yeni tablo `terraform import` ile state'e alınır ve Streams / TTL / PITR / silme koruması yeniden açılır:

```powershell
aws dynamodb update-continuous-backups --table-name $DST --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
aws dynamodb update-time-to-live --table-name $DST --time-to-live-specification "Enabled=true,AttributeName=ttl"
aws dynamodb update-table --table-name $DST --stream-specification StreamEnabled=true,StreamViewType=NEW_IMAGE --deletion-protection-enabled
```

3. Outbox relay event source mapping'i yeni tablonun stream ARN'ine bağlanır (Terraform `outbox.tf`).
4. `scheduler_enabled = true`; ertesi sabah `ledger_audit` alarmları ve DLQ kontrol edilir.
5. Eski tablo **silinmez** (silme koruması açık kalır); olay incelemesi bitene kadar salt okunur kanıt olarak tutulur.

## 7. Tatbikatı kapatma (geçiş yapılmadıysa)

```powershell
aws dynamodb delete-table --table-name $DST
aws dynamodb delete-table --table-name $DSTA
```

(Geri yüklenen tablolarda silme koruması kapalıdır; kaynak tablolar etkilenmez.)

## 8. Tatbikat kaydı

Her tatbikatta aşağıdaki satırı `claude/adim2-olcek-ve-dayaniklilik.md` (veya operasyon günlüğü) altına ekleyin:

| Tarih | Ortam | Geri dönülen an (UTC) | Geri yükleme süresi | Öğe sayısı | `--verify` sonuçları | `ledger_audit` bulgusu | Not |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | dev | | | | 4/4 OK | 0 | |

Hedefler: geri yükleme + doğrulama **≤ 60 dk** (RTO), veri kaybı en fazla geri dönülen an ile olay arasındaki süre (RPO ≈ saniyeler; PITR sürekli).
