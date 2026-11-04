output "instance_id" {
  value = aws_instance.web.id
}

output "public_ip" {
  value = aws_eip.web.public_ip
}

output "url" {
  value = "http://${aws_eip.web.public_ip}"
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}
