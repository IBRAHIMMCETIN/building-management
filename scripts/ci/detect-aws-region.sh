#!/usr/bin/env bash
# Projenin AWS region'ini bulur ve sonraki adimlar icin AWS_REGION olarak ayarlar.
#
# Bu hesap AWS'nin "projects" deneyiminde acildi. AWS'nin yonettigi SCP, projenin
# secili region'i disinda neredeyse her islemi engelliyor (us-east-1 ve us-west-2'de
# yalnizca IAM gibi global servisler acik). Bu yuzden bolgesel bir okuma
# cagrisinin izin verildigi tek region, projenin region'idir.
set -euo pipefail

preferred="${AWS_REGION:-}"

probe() {
  aws ec2 describe-vpcs --region "$1" --max-items 1 --query 'Vpcs[0].VpcId' --output text >/dev/null 2>&1
}

if [ -n "$preferred" ] && probe "$preferred"; then
  region="$preferred"
else
  allowed=()
  for r in $(aws ec2 describe-regions --region us-east-1 --query 'Regions[].RegionName' --output text); do
    if probe "$r"; then
      allowed+=("$r")
    fi
  done

  if [ "${#allowed[@]}" -ne 1 ]; then
    echo "::error::Projenin region'i bulunamadi. Bolgesel islemlere izin veren region'lar: ${allowed[*]:-yok}"
    exit 1
  fi

  region="${allowed[0]}"
  echo "::warning::Ayarli region bu hesapta SCP ile engelli. Projenin region'i kullaniliyor: $region. Repo variable AWS_REGION'i '$region' yap ve AWS_REGION secret'ini sil."
fi

echo "AWS_REGION=$region" >> "$GITHUB_ENV"
echo "AWS_DEFAULT_REGION=$region" >> "$GITHUB_ENV"
echo "Projenin region'i: $region"
