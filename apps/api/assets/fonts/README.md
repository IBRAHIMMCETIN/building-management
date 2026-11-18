# PDF yazı tipleri

Makbuz PDF'lerinde kullanılan **Noto Sans** (Regular, Bold). Lisans: SIL Open Font License 1.1 (`OFL.txt`).

Standart PDF fontları Türkçe karakterleri (ğ, ş, ı, İ) ve `₺` işaretini içermediği için TrueType font gömülür.
Dosyalar yalnızca gerekli karakterlerle alt kümeye indirilmiştir (her biri ~21 KB). pdf-lib'in kendi alt küme
üretimi bu fontta glifleri bozduğu için PDF'e tam gömülürler.

Kaynak: `@expo-google-fonts/noto-sans@0.4.2` (Google Fonts). Yeniden üretmek için (Python `fonttools`):

```bash
U="U+0020-007E,U+00A0-00FF,U+011E-011F,U+0130-0131,U+015E-015F,U+2013-2014,U+2018-201E,U+2022,U+2026,U+20AC,U+20BA,U+2212"
pyftsubset NotoSans_400Regular.ttf --unicodes="$U" --layout-features='kern,liga' --no-hinting --desubroutinize --name-IDs='*' --output-file=NotoSans-Regular.ttf
pyftsubset NotoSans_700Bold.ttf    --unicodes="$U" --layout-features='kern,liga' --no-hinting --desubroutinize --name-IDs='*' --output-file=NotoSans-Bold.ttf
```

Lambda paketine `npm run build:lambda` sırasında `dist/lambda/fonts/` altına kopyalanır.
