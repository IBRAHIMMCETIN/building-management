# ---------------------------------------------------------------------------
# Tanitim sayfasi (web `/`): kimliksiz demo talep formu.
#
# `POST /api/public/demo-requests` JWT'siz ayri rotadir (daha ozel rota `ANY /api/{proxy+}` JWT
# rotasindan onceliklidir). Bu rota yalnizca yazar, hicbir veri okumaz (apps/api
# modules/demo-requests). Koruma katmanlari:
#   - API Gateway rota throttling'i: platform geneli TEK kova; yalnizca arka ucu ve maliyeti korur,
#     bu yuzden mesru kullanimi kesmeyecek kadar yuksek (10/sn, burst 20),
#   - uygulamada istemci basina (IPv4 adresi / IPv6 /64: saatte 5) ve ag basina (IPv4 /24 / IPv6 /48:
#     saatte 20) sabit pencere sayaclari, IP API Gateway `sourceIp`'sinden (DynamoDB `DEMOTHR#`, TTL);
#     sayac anahtari asagidaki KMS HMAC anahtariyla uretilir (ham IP saklanmaz),
#   - platform geneli gunluk hacim: 200 ustu talepler kaydedilir ama `suspect` isaretlenir ve
#     asagidaki alarm uretilir; 2.000 sert ust sinir (maliyet korumasi),
#   - kati sema, 16 KB govde siniri ve bal kupu alani.
# Bot korumasi (Cloudflare Turnstile) ve kenarda IP basina sinir Adim 11'de (alan adi + Cloudflare
# WAF); o zaman `sourceIp` Cloudflare cikis adresi olur ve istemci IP'si `CF-Connecting-IP`'den okunmalidir.
# CORS: API'nin `cors_configuration` ayarlari (ayni kokenler) bu rotaya da uygulanir. API Gateway'in
# kendi 429 (throttling) yanitinda CORS basliklari olmayabilir; web formu bu durumda ag hatasini
# "cok fazla istek / biraz sonra deneyin" olarak gosterir.
# ---------------------------------------------------------------------------

locals {
  public_form_routes = toset(["POST /api/public/demo-requests"])
}

resource "aws_apigatewayv2_route" "public_form" {
  for_each = local.public_form_routes

  api_id             = aws_apigatewayv2_api.http.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "NONE"
}

# Deneme sayaci anahtarlari icin IP HMAC'i (bank.tf IBAN HMAC'i ile ayni desen): anahtar KMS'ten
# cikmaz; API rolu yalnizca GenerateMac (HMAC_SHA_256) yapar (api.tf). Sayaclar en fazla 25 saat
# yasadigindan anahtar degisimi yalnizca o pencerenin sayaclarini sifirlar.
resource "aws_kms_key" "demo_ip_hmac" {
  description              = "${local.name}: tanitim sayfasi demo formu deneme sayaci IP HMAC anahtari"
  key_usage                = "GENERATE_VERIFY_MAC"
  customer_master_key_spec = "HMAC_256"
  deletion_window_in_days  = local.is_prod ? 30 : 7
}

resource "aws_kms_alias" "demo_ip_hmac" {
  name          = "alias/${local.name}-demo-ip-hmac"
  target_key_id = aws_kms_key.demo_ip_hmac.key_id
}

# Platform geneli olagan hacim asildi (bot dalgasi olabilir): talepler kaydedilmeye devam eder ama
# `suspect` isaretlidir. Ayrinti: API loglarinda msg=demo_request_received suspect=true; platform
# panelinde Demo Talepleri listesi ("Şüpheli" rozeti), gerekirse "Spam" ile kaldirilir.
resource "aws_cloudwatch_metric_alarm" "demo_request_suspect" {
  alarm_name          = "${local.name}-demo-request-suspect"
  alarm_description   = "Tanitim sayfasi demo formunda gunluk olagan hacim (200) asildi; supheli talepler kaydediliyor. API loglari: msg=demo_request_received suspect=true."
  namespace           = local.metrics_namespace
  metric_name         = "DemoRequestSuspect"
  dimensions          = local.metrics_dimensions
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
