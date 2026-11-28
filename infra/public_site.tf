# ---------------------------------------------------------------------------
# Tanitim sayfasi (web `/`): kimliksiz demo talep formu.
#
# `POST /api/public/demo-requests` JWT'siz ayri rotadir (daha ozel rota `ANY /api/{proxy+}` JWT
# rotasindan onceliklidir). Bu rota yalnizca yazar, hicbir veri okumaz (apps/api
# modules/demo-requests). Koruma katmanlari:
#   - API Gateway rota throttling'i (platform geneli kova; arka ucu ve maliyeti korur),
#   - uygulamada IP basina sabit pencere sayaci (1 saatte 5) + platform geneli gunluk sinir (200),
#     IP API Gateway `sourceIp`'sinden (DynamoDB `DEMOTHR#`, TTL ile duser),
#   - kati sema, 16 KB govde siniri ve bal kupu alani.
# Ileride (alan adi + Cloudflare WAF, Adim 11) IP basina sinir kenarda da uygulanabilir; o zaman
# `sourceIp` Cloudflare cikis adresi olur ve istemci IP'si `CF-Connecting-IP`'den okunmalidir.
# CORS: API'nin `cors_configuration` ayarlari (ayni kokenler) bu rotaya da uygulanir.
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
