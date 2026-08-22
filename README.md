# HX Chat

Aplicativo estilo Discord com servidor único **HX**: login com conta, chat de texto, canal de voz e transmissão de tela com prévia.

## Rodar

```
npm install
npm start
```

Abra http://localhost:3000, crie uma conta (usuário + senha) e entre.

- **Conta**: senha guardada no SQLite apenas como hash scrypt + salt único — irreversível, nenhum dev consegue ler a senha.
- **Chat**: #geral, histórico das últimas 100 mensagens persistido no SQLite (sobrevive a restart). Editar/apagar as próprias mensagens, colar print com Ctrl+V, @menção com destaque e som, links clicáveis, mensagens seguidas agrupadas, indicador "fulano está digitando…", contador de não lidas no título da aba com som de alerta.
- **Membros**: lista com seções Online/Offline e contagem (todas as contas do servidor aparecem).
- **Voz**: várias salas (ex.: `akon_lonely_brega.mp3`, `Tibia`) — clique numa para entrar e permita o microfone; clicar em outra troca de sala sem sair da voz. Áudio P2P (WebRTC mesh), isolado por sala. Mutar (Ctrl+Shift+M), silenciar o canal (Ctrl+Shift+D) e push-to-talk opcional (tecla configurável no perfil) com indicadores visíveis para todos (mic + headset, como no Discord); volume individual por participante (no perfil dele); sons sintetizados (WebAudio) para os eventos da call. As salas são definidas em `VOICE_ROOMS` no [server.js](server.js).
- **Transmitir tela**: dentro da voz, botão de monitor — o seletor do navegador oferece tela inteira, janela ou aplicativo aberto (mesmo mecanismo do Discord).
- **Assistir**: quem transmite ganha o badge vermelho **AO VIVO** ao lado do nome no canal de voz. Clique no badge para ver a prévia (atualizada a cada 3s) e então **Assistir** — o vídeo só é enviado a quem assiste.
- Outra pessoa na mesma rede: http://SEU_IP:3000 (mic/tela fora de localhost exigem HTTPS).

## Deploy permanente

O servidor detecta sozinho um disco/volume montado em `/data` e guarda o banco lá (contas
sobrevivem a deploy). Sem volume, o banco é efêmero e zera a cada deploy. Em VPS o
filesystem é persistente por natureza — o banco fica em `hx.db` no diretório do app.

### VPS própria (Ubuntu + Caddy) — [deploy/setup-vps.sh](deploy/setup-vps.sh)

Pré-requisitos: Node 22+, domínio com A record apontando pro IP da VPS. Como root:

```
curl -fsSL https://raw.githubusercontent.com/hberdu/hxserver/main/deploy/setup-vps.sh | bash
```

Instala Caddy (HTTPS automático via Let's Encrypt), clona o app em `/opt/hx`, cria o serviço
systemd `hx` (sobe no boot, reinicia se cair) e configura o proxy. Rodar de novo = atualizar.
Outro domínio: `... | bash -s -- meudominio.com`. Logs: `journalctl -u hx -f`.

Registro é **público** (qualquer um cria conta) — pensado para um grupo de amigos, sem configuração. Não depende de variáveis de ambiente.

Anti-abuso embutido: limite de conexões e de tentativas de login **por IP** (sobrevive à reconexão), semáforo de scrypt (flood de login não trava o servidor), cabeçalhos CSP/HSTS/nosniff/anti-clickjacking, checagem de origem no handshake e rotação de token de sessão. Métricas de `/healthz` ficam atrás de um token (`/healthz?token=hx-metrics`); sem ele, `/healthz` devolve só `{ok:true}`.

**Monitoramento:** aponte um monitor externo grátis (UptimeRobot, cron-job.org) para `https://SEU-APP/healthz` a cada 5 min — avisa quando o servidor cai.

## Publicar na web (túnel temporário)

```
npm run tunnel
```

Gera uma URL pública `https://….trycloudflare.com` (HTTPS, mic/tela funcionam) enquanto seu PC estiver ligado com `npm start` rodando. A URL muda a cada execução do túnel. Para endereço fixo, use a VPS (seção acima) ou crie um túnel nomeado com conta Cloudflare.

## Instalar como aplicativo (PWA)

Abra o site no Chrome/Edge e clique no ícone **Instalar** na barra de endereço (ou menu → "Instalar HX Chat"). Vira janela própria com ícone, igual WhatsApp Web instalado.

## Testes

```
npm test
```

## Stack

Node.js + Express + Socket.IO (auth, chat, sinalização), `node:sqlite` (contas), `crypto.scrypt` (hash de senha), WebRTC mesh (voz/tela), cliente HTML/JS puro.

Anti-flood: token bucket por socket no servidor (chat, thumbs, tentativas de login). Conexão nova da mesma conta substitui a antiga (sem fantasmas na lista após reconexão).

Limitações: só STUN — NAT restritivo precisa de TURN em `RTC_CONFIG` (public/app.js).
