# ---------------------------------------------------------------------------
# Faz B1: banka ekstresi aktarimi (apps/api/src/modules/finance/bank).
#
# - Ekstre dosyalari mevcut belge bucket'inda: apartments/{apartmentId}/bank-statements/{yyyy}/{mm}/
#   {statementId}. Tarayici yalnizca API'nin urettigi 5 dakikalik imzali PUT ile yukler; dosyayi API
#   okur. API rolunun `apartments/*` GetObject/PutObject yetkisi (api.tf) yeterlidir, yeni S3 yetkisi yok.
# - Karsi taraf IBAN'i duz metin saklanmaz. Eslestirme icin KMS HMAC (GenerateMac, HMAC_SHA_256)
#   ozeti saklanir; anahtar KMS'ten cikmaz, ozetten IBAN'a donulemez.
# - HMAC anahtarlarinda otomatik anahtar dondurme YOKTUR (KMS yalnizca simetrik sifreleme
#   anahtarlarini dondurur). Anahtar degisirse eski ozetler yeni ozetlerle eslesmez: anahtar silinmemeli,
#   gerekirse yeni anahtar + `k2:` onekiyle gecis yapilir.
# - Hassas yazma rotalari (upload-url, onizleme, aktarim) security_monitoring.tf'de toplu yazim sinirina
#   tabidir.
# ---------------------------------------------------------------------------

resource "aws_kms_key" "bank_iban_hmac" {
  description              = "${local.name}: banka ekstresi karsi taraf IBAN HMAC ozeti (eslestirme anahtari)"
  key_usage                = "GENERATE_VERIFY_MAC"
  customer_master_key_spec = "HMAC_256"
  deletion_window_in_days  = local.is_prod ? 30 : 7
}

resource "aws_kms_alias" "bank_iban_hmac" {
  name          = "alias/${local.name}-bank-iban-hmac"
  target_key_id = aws_kms_key.bank_iban_hmac.key_id
}
