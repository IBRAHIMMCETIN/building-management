#!/usr/bin/env bash
# EC2 uzerinde SSM Run Command ile root olarak calisir. Idempotent: her deploy'da
# Node.js'i, servis kullanicisini ve systemd servisini gerekirse kurar, yeni
# release'i acar, servisi yeniden baslatir ve saglik kontrolu yapar.
#
# Kullanim: remote-deploy.sh <bucket> <release-key> <version> <node-version> <region>
set -euo pipefail

BUCKET="$1"
KEY="$2"
VERSION="$3"
NODE_VERSION="$4"
REGION="$5"

APP=building-management
APP_DIR=/opt/$APP
NODE_DIR=/opt/node
SERVICE_USER=bm

log() { echo "[deploy] $*"; }

# 1) Node.js: sabit surum, resmi tarball, SHA256 dogrulamali.
if [ "$("$NODE_DIR/bin/node" --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  case "$(uname -m)" in
    aarch64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) echo "Desteklenmeyen mimari: $(uname -m)" >&2; exit 1 ;;
  esac
  file="node-v$NODE_VERSION-linux-$arch.tar.gz"
  tmp=$(mktemp -d)
  log "Node.js v$NODE_VERSION kuruluyor ($arch)"
  curl -fsSL --retry 5 "https://nodejs.org/dist/v$NODE_VERSION/$file" -o "$tmp/$file"
  curl -fsSL --retry 5 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "$NODE_DIR.new"
  mkdir -p "$NODE_DIR.new"
  tar -xzf "$tmp/$file" -C "$NODE_DIR.new" --strip-components=1 --no-same-owner
  rm -rf "$NODE_DIR"
  mv "$NODE_DIR.new" "$NODE_DIR"
  rm -rf "$tmp"
fi

# 2) Servis kullanicisi ve klasorler.
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER"
mkdir -p "$APP_DIR/releases"

# 3) Release'i indir ve ac.
release="$APP_DIR/releases/$VERSION"
if [ ! -f "$release/server.mjs" ]; then
  log "Release indiriliyor: s3://$BUCKET/$KEY"
  tmp=$(mktemp -d)
  aws s3 cp "s3://$BUCKET/$KEY" "$tmp/release.tar.gz" --region "$REGION" --only-show-errors
  rm -rf "$release"
  mkdir -p "$release"
  tar -xzf "$tmp/release.tar.gz" -C "$release" --no-same-owner
  rm -rf "$tmp"
fi
ln -sfn "$release" "$APP_DIR/current"

# 4) systemd servisi. Port 80 icin root yerine CAP_NET_BIND_SERVICE kullanilir.
cat > "/etc/systemd/system/$APP.service" <<EOF
[Unit]
Description=$APP web + API
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE_USER
WorkingDirectory=$APP_DIR/current
Environment=NODE_ENV=production
Environment=PORT=80
Environment=APP_VERSION=$VERSION
ExecStart=$NODE_DIR/bin/node $APP_DIR/current/server.mjs
Restart=always
RestartSec=2
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --quiet "$APP"
systemctl restart "$APP"

# 5) Saglik kontrolu: yeni surum cevap veriyor mu?
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1/api/health 2>/dev/null | grep -q "$VERSION"; then
    log "Saglikli: $VERSION"
    # Son 5 release kalsin.
    ls -1dt "$APP_DIR"/releases/*/ | tail -n +6 | xargs -r rm -rf
    exit 0
  fi
  sleep 1
done

echo "Servis saglik kontrolunu gecemedi" >&2
journalctl -u "$APP" -n 50 --no-pager >&2 || true
exit 1
