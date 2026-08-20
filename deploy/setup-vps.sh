#!/usr/bin/env bash
# Setup do HX Chat numa VPS Ubuntu (testado no 20.04+). Rodar como root:
#   curl -fsSL https://raw.githubusercontent.com/hberdu/hxserver/main/deploy/setup-vps.sh | bash
# Idempotente: rodar de novo atualiza o app e reinicia o serviço.
set -euo pipefail

DOMAIN="${1:-hx-chat.com.br}"
REPO="https://github.com/hberdu/hxserver.git"
APP_DIR=/opt/hx

# Node 22+ (node:sqlite): instala via NodeSource se ausente ou velho
if ! command -v node >/dev/null || ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)'; then
  echo "== Instalando Node 22 (NodeSource) =="
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
NODE_BIN="$(command -v node)"

echo "== Pacotes base + Caddy =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl git gnupg
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy
fi

echo "== App em $APP_DIR =="
id -u hx &>/dev/null || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin hx
git config --global --add safe.directory "$APP_DIR" || true
if [ -d "$APP_DIR/.git" ]; then
  # reset --hard: segue o GitHub mesmo após histórico reescrito (hx.db está fora do git, não corre risco)
  git -C "$APP_DIR" fetch origin
  git -C "$APP_DIR" reset --hard origin/main
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund
chown -R hx:hx "$APP_DIR"

echo "== systemd =="
cat > /etc/systemd/system/hx.service <<EOF
[Unit]
Description=HX Chat
After=network.target

[Service]
User=hx
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=3
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable hx >/dev/null 2>&1
systemctl restart hx

echo "== Caddy (HTTPS automático para $DOMAIN) =="
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  reverse_proxy localhost:3000
}
EOF
systemctl reload caddy || systemctl restart caddy

# Firewall: só se o ufw estiver ativo (40000-40100 = mídia do SFU/mediasoup)
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw allow 40000:40100/udp >/dev/null; ufw allow 40000:40100/tcp >/dev/null
fi

echo "== Verificação =="
sleep 2
curl -fsS http://localhost:3000/healthz && echo " <- app ok na porta 3000"
IP_DNS="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
IP_VPS="$(curl -fsS -4 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
if [ "$IP_DNS" != "$IP_VPS" ]; then
  echo "AVISO: DNS de $DOMAIN aponta para '$IP_DNS', VPS é '$IP_VPS'."
  echo "Certificado HTTPS só sai quando o A record apontar para a VPS (o Caddy fica tentando sozinho)."
fi
echo "Pronto: https://$DOMAIN — status do app: systemctl status hx | logs: journalctl -u hx -f"
