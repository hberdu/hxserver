#!/usr/bin/env bash
# Libera as portas 80/443 (para o serviço web antigo, ex.: treinobot) e sobe o Caddy do HX.
# ATENÇÃO: o serviço que estiver publicando 80/443 é parado em DEFINITIVO (não volta no boot).
set -u

echo "== quem segura 80/443 =="
ss -tlnp | grep -E ':(80|443) ' || echo "(ninguém)"

systemctl stop nginx 2>/dev/null && systemctl disable nginx 2>/dev/null && echo "nginx parado"
systemctl stop apache2 2>/dev/null && systemctl disable apache2 2>/dev/null && echo "apache parado"

if command -v docker >/dev/null 2>&1; then
  docker ps --format '{{.ID}} {{.Names}} {{.Ports}}' | grep -E ':(80|443)->' | while read -r id name ports; do
    docker stop "$id" >/dev/null && docker update --restart=no "$id" >/dev/null \
      && echo "container $name parado ($ports)"
  done
fi

# Qualquer outro processo ainda pendurado nas portas (caddy antigo, node com tls, etc.)
for port in 80 443; do
  pid="$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  if [ -n "${pid:-}" ]; then
    comm="$(ps -p "$pid" -o comm= 2>/dev/null || echo '?')"
    if [ "$comm" != "caddy" ]; then
      echo "matando $comm (pid $pid) na porta $port"
      kill "$pid" 2>/dev/null; sleep 1; kill -9 "$pid" 2>/dev/null || true
    fi
  fi
done

systemctl restart caddy
sleep 3
echo "== caddy: $(systemctl is-active caddy) =="
echo "== portas agora =="
ss -tlnp | grep -E ':(80|443) ' || echo "(ninguém)"
