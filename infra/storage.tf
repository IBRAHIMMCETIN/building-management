# ---------------------------------------------------------------------------
# Belge deposu (S3): tahsilat makbuzlari (PDF) ve gider faturalari.
#
# - Tamamen private: herkese acik erisim engelli, ACL kapali (BucketOwnerEnforced), yalnizca
#   TLS. Istemciler dosyaya YALNIZCA API'nin urettigi 5 dakikalik imzali URL ile erisir.
# - Anahtar duzeni (apps/api/src/modules/documents/keys.ts):
#     apartments/{apartmentId}/receipts/{yyyy}/{mm}/...   makbuz onbellegi
#     apartments/{apartmentId}/invoices/{yyyy}/{mm}/...   gider faturalari
#     apartments/{apartmentId}/bank-statements/{yyyy}/{mm}/{statementId}
#                                                         banka ekstresi dosyalari (Faz B1; kalici)
#     tmp/{apartmentId}/invoice-uploads/{uploadId}        tarayicidan yuklenen, henuz gidere
#                                                         baglanmamis dosya (1 gunde silinir)
# - Surumleme acik: yanlislikla uzerine yazilan dosya geri alinabilir (eski surumler 90 gun).
# - Sifreleme: SSE-S3 (AES-256). Imzali URL'lerle sorunsuz calisir; KMS anahtari gerektirmez.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "documents" {
  bucket = "${local.name}-documents-${data.aws_caller_identity.current.account_id}-${local.region}"

  # Prod'da belge kaybi olmamasi icin bos olmayan bucket silinemez.
  force_destroy = !local.is_prod
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    id     = "pending-uploads"
    status = "Enabled"
    filter {
      prefix = "tmp/"
    }
    expiration {
      days = 1
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  rule {
    id     = "old-versions"
    status = "Enabled"
    filter {
      prefix = "apartments/"
    }
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }

  rule {
    id     = "abort-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.documents]
}

# Tarayicidan imzali URL ile yukleme (PUT) ve indirme (GET).
resource "aws_s3_bucket_cors_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  cors_rule {
    allowed_methods = ["GET", "PUT"]
    allowed_origins = local.cors_allow_origins
    allowed_headers = ["content-type"]
    max_age_seconds = 3600
  }
}

data "aws_iam_policy_document" "documents_bucket" {
  # Sifresiz (HTTP) erisim reddedilir.
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.documents.arn,
      "${aws_s3_bucket.documents.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "documents" {
  bucket = aws_s3_bucket.documents.id
  policy = data.aws_iam_policy_document.documents_bucket.json

  # Public access block once uygulanmali.
  depends_on = [aws_s3_bucket_public_access_block.documents]
}
