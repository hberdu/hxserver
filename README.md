# HX Chat

Aplicativo estilo Discord com servidor único **HX**: login com conta, chat de texto, canal de voz e transmissão de tela com prévia.

## Rodar

```
npm install
npm start
```

Abra http://localhost:3000, crie uma conta (usuário + senha) e entre.

- **Conta**: senha guardada no SQLite apenas como hash scrypt + salt único — irreversível, nenhum dev consegue ler a senha.
- **Chat**: #geral, histórico das últimas 100 mensagens (em memória).
- **Voz**: clique em "Voz" e permita o microfone. Áudio P2P (WebRTC mesh). Ícones monocromáticos, sons sintetizados (WebAudio) para mutar/desmutar, transmitir e sair.
- **Transmitir tela**: dentro da voz, botão de monitor — o seletor do navegador oferece tela inteira, janela ou aplicativo aberto (mesmo mecanismo do Discord).
- **Assistir**: quem transmite ganha o badge vermelho **AO VIVO** ao lado do nome no canal de voz. Clique no badge para ver a prévia (atualizada a cada 3s) e então **Assistir** — o vídeo só é enviado a quem assiste.
- Outra pessoa na mesma rede: http://SEU_IP:3000 (mic/tela fora de localhost exigem HTTPS).

## Publicar na web

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

Limitações: mensagens em memória (somem no restart; contas persistem em `hx.db`); só STUN — NAT restritivo precisa de TURN em `RTC_CONFIG` (public/app.js).
