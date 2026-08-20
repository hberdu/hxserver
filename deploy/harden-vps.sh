#!/usr/bin/env bash
# Hardening básico da VPS do HX: firewall, anti-brute-force de SSH, patches automáticos
# e backup diário do banco. Idempotente.
set -u
export DEBIAN_FRONTEND=noninteractive

echo "== pacotes =="
apt-get update -qq
apt-get install -y -qq ufw fail2ban unattended-upgrades sqlite3

echo "== firewall: só SSH/80/443 =="
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable
# fecha o acesso direto à porta 3000 do Node (só o Caddy fala com ela por dentro)

echo "== fail2ban (bane IP que erra senha de SSH repetidamente) =="
systemctl enable --now fail2ban >/dev/null 2>&1

echo "== patches de segurança automáticos =="
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo "== backup diário do banco (14 dias em /root/hx-backups) =="
cat > /etc/cron.daily/hx-backup <<'EOF'
#!/bin/sh
mkdir -p /root/hx-backups
sqlite3 /opt/hx/hx.db ".backup /root/hx-backups/hx-$(date +\%F).db" 2>/dev/null
ls -1t /root/hx-backups/hx-*.db 2>/dev/null | tail -n +15 | xargs -r rm
EOF
chmod +x /etc/cron.daily/hx-backup
/etc/cron.daily/hx-backup && echo "primeiro backup feito: $(ls /root/hx-backups | tail -1)"

echo "== resumo =="
ufw status | head -10
systemctl is-active fail2ban && echo "fail2ban ok"
echo "pronto"
