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
- **Voz**: clique em "Voz" e permita o microfone. Áudio P2P (WebRTC mesh). Mutar (Ctrl+Shift+M), silenciar o canal (Ctrl+Shift+D) e push-to-talk opcional (tecla configurável no perfil) com indicadores visíveis para todos (mic + headset, como no Discord); volume individual por participante (aparece no hover); sons sintetizados (WebAudio) para os eventos da call.
- **Transmitir tela**: dentro da voz, botão de monitor — o seletor do navegador oferece tela inteira, janela ou aplicativo aberto (mesmo mecanismo do Discord).
- **Assistir**: quem transmite ganha o badge vermelho **AO VIVO** ao lado do nome no canal de voz. Clique no badge para ver a prévia (atualizada a cada 3s) e então **Assistir** — o vídeo só é enviado a quem assiste.
- Outra pessoa na mesma rede: http://SEU_IP:3000 (mic/tela fora de localhost exigem HTTPS).

## Deploy permanente (Render — URL fixa hx-chat.onrender.com)

1. Crie um repositório em https://github.com/new (ex: `hx-chat`, privado serve)
2. No terminal do projeto:
   ```
   git remote add origin https://github.com/SEU_USUARIO/hx-chat.git
   git push -u origin main
   ```
3. Em https://render.com: login com GitHub → **New → Blueprint** → escolha o repo → Apply (o [render.yaml](render.yaml) configura tudo)
4. URL final: `https://hx-chat.onrender.com` (se o nome estiver ocupado, o Render sufixa)

Limitações do plano grátis: a instância dorme após ~15min sem uso (primeiro acesso demora ~30s) e o disco é efêmero — `hx.db` zera a cada deploy/restart (contas precisam ser recriadas). Para persistir: disco pago do Render ou migrar contas para Postgres.

## Publicar na web (túnel temporário)

```
npm run tunnel
```

Gera uma URL pública `https://….trycloudflare.com` (HTTPS, mic/tela funcionam) enquanto seu PC estiver ligado com `npm start` rodando. A URL muda a cada execução do túnel. Para endereço fixo, hospede em um serviço Node (Render, Railway, Fly.io) ou crie um túnel nomeado com conta Cloudflare.

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
