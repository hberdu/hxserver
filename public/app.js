/* HX Chat — cliente: login, chat via Socket.IO, voz e tela via WebRTC mesh */
const socket = io();
const $ = (id) => document.getElementById(id);

// ---------- Micro-animações (GSAP): curtas e discretas — realce, não espetáculo ----------
// Respeita "reduzir movimento" do sistema; sem GSAP (cache antigo offline) vira no-op.
const fx = (window.gsap && !matchMedia('(prefers-reduced-motion: reduce)').matches) ? window.gsap : null;
// Entrada de item (mensagem, membro, tile): fade + deslize sutil de baixo
function fxIn(el, opts = {}) {
  if (fx && el) fx.from(el, { opacity: 0, y: 6, duration: 0.25, ease: 'power2.out', clearProps: 'all', ...opts });
}
// Abertura de modal: card cresce de 97% com fade (overlay em si não anima — menos ruído)
function fxModal(overlay) {
  if (fx && overlay) fx.from(overlay.firstElementChild, { opacity: 0, scale: 0.97, y: 8, duration: 0.2, ease: 'power2.out', clearProps: 'all' });
}
// Toque em botão de estado (mute/deafen/servidor): pulso tátil curto
function fxTap(el) {
  if (fx && el) fx.fromTo(el, { scale: 0.86 }, { scale: 1, duration: 0.3, ease: 'back.out(2.5)', clearProps: 'transform' });
}
// Saída de item: fade rápido subindo, remove do DOM no fim (sem GSAP remove na hora)
function fxOut(el, done) {
  if (!el) { if (done) done(); return; }
  if (!fx) { el.remove(); if (done) done(); return; }
  fx.to(el, { opacity: 0, y: -4, duration: 0.15, ease: 'power1.in', onComplete: () => { el.remove(); if (done) done(); } });
}
fxIn(document.querySelector('.login-box'), { y: 14, duration: 0.4 }); // tela de login entra suave

let selfId = null;
let username = null;

// Reconexão: o servidor perdeu o estado desta conexão (novo socket.id). Recarrega e a sessão
// guardada devolve o usuário ao servidor sozinho — restart/deploy não cai na tela de login.
socket.io.on('reconnect', () => { if (username && !superseded) location.reload(); });

socket.on('server-restarting', () => showBanner('Servidor reiniciando… reconectando em instantes'));
socket.on('disconnect', () => { if (username && !superseded) showBanner('Conexão perdida… reconectando'); });
socket.on('connect', () => hideBanner());

// A mesma conta entrou em outra aba/dispositivo: esta conexão foi substituída
let superseded = false;
socket.on('session-superseded', () => {
  superseded = true;
  socket.disconnect(); // não reconectar: a outra aba assumiu
  showBanner('Sua conta entrou em outra aba ou dispositivo. Recarregue para usar aqui.');
});

function showBanner(text) {
  let el = $('conn-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'conn-banner';
    document.body.appendChild(el);
  }
  const wasVisible = el.textContent && !el.classList.contains('hidden');
  el.textContent = text;
  el.classList.remove('hidden');
  if (!wasVisible) fxIn(el, { y: -16, duration: 0.3 }); // desce do topo; troca de texto não re-anima
}

function hideBanner() {
  $('conn-banner')?.classList.add('hidden');
}

// PWA: instalável como aplicativo (ícone na barra de endereço / menu do navegador)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // SW novo assumiu (deploy): recarrega uma vez para rodar o código novo.
  // No primeiro install o claim também dispara isto — aí a página já é a mais nova, só marca.
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    location.reload();
  });
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('install-btn').classList.remove('hidden');
  $('install-side').classList.remove('hidden'); // só aparece quando o prompt nativo existe
});
// Abre o prompt nativo de instalação; esconde os botões (voltam se o navegador re-oferecer)
async function consumeInstallPrompt() {
  if (!installPrompt) return false;
  const p = installPrompt;
  installPrompt = null; // anula antes do await: duplo clique não chama prompt() duas vezes
  $('install-btn').classList.add('hidden');
  $('install-side').classList.add('hidden');
  p.prompt();
  await p.userChoice.catch(() => {});
  return true;
}
$('install-btn').onclick = consumeInstallPrompt;

// Sugere instalar como app na PRIMEIRA vez que o usuário entra (uma vez por dispositivo)
function maybeSuggestInstall() {
  if (localStorage.getItem('hx-install-done')) return;
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
  if (standalone) { localStorage.setItem('hx-install-done', '1'); return; } // já instalado
  localStorage.setItem('hx-install-done', '1'); // mostra só nesta primeira vez
  $('install-overlay').classList.remove('hidden');
  fxModal($('install-overlay'));
}
$('install-yes').onclick = async () => {
  $('install-overlay').classList.add('hidden');
  if (!(await consumeInstallPrompt())) {
    systemMessage('Para instalar: menu do navegador → "Instalar aplicativo" (ou ícone na barra de endereço).');
  }
};
$('install-no').onclick = () => $('install-overlay').classList.add('hidden');

// Sair da conta: mata a sessão no servidor, some com o token local e volta pro login
$('logout-btn').onclick = () => {
  socket.emit('logout', { token: localStorage.getItem('hx-token') });
  localStorage.removeItem('hx-token');
  sessionStorage.removeItem('hx-voice-room');
  location.reload();
};

// Botão fixo no fim da lista de membros: clique abre o prompt nativo direto
$('install-side').onclick = consumeInstallPrompt;
window.addEventListener('appinstalled', () => $('install-side').classList.add('hidden'));

// ---------- Avatares (foto do perfil, ou inicial com cor determinística) ----------
const avatares = new Map(); // username -> data URL da foto

function styleAvatar(div, name) {
  const photo = avatares.get(name);
  if (photo) {
    // Nunca usar a shorthand "background" aqui: ela zera size/position e o recorte sai do centro
    div.style.background = 'none';
    div.style.backgroundImage = 'url("' + photo + '")';
    div.style.backgroundSize = 'cover';
    div.style.backgroundPosition = 'center';
    div.textContent = '';
  } else {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    div.style.backgroundImage = '';
    div.style.background = 'hsl(' + (h % 360) + ' 55% 45%)';
    div.textContent = (String(name)[0] || '?').toUpperCase();
  }
}

function avatarEl(name, size) {
  const div = document.createElement('div');
  div.className = 'avatar';
  div.dataset.name = name;
  div.style.width = div.style.height = size + 'px';
  div.style.fontSize = Math.round(size * 0.45) + 'px';
  styleAvatar(div, name);
  return div;
}

function refreshAvatars(name) {
  document.querySelectorAll('.avatar[data-name="' + CSS.escape(name) + '"]')
    .forEach((div) => styleAvatar(div, name));
}

socket.on('avatar-changed', ({ username: name, avatar }) => {
  if (typeof name !== 'string') return;
  if (typeof avatar === 'string') avatares.set(name, avatar);
  else avatares.delete(name); // foto removida
  refreshAvatars(name);
});

// ---------- Sons (WebAudio sintetizado, sem arquivos) ----------
const SOUNDS = {
  unmute:    [[392, 0, .12], [523.25, .1, .18]],
  mute:      [[523.25, 0, .12], [392, .1, .18]],
  leave:     [[440, 0, .1], [349.23, .11, .1], [261.63, .22, .25]],
  screenOn:  [[440, 0, .1], [659.25, .12, .2]],
  screenOff: [[659.25, 0, .1], [440, .12, .2]],
  userJoin:  [[587.33, 0, .09], [880, .1, .22]],   // alguém entrou na call: sobe
  userLeave: [[880, 0, .09], [587.33, .1, .22]],   // alguém saiu: desce
  notify:    [[880, 0, .08], [1174.66, .09, .15]], // mensagem nova com a aba em segundo plano
};
let audioCtx = null;

// Destrava o áudio no primeiro clique: sem isso o contexto fica suspenso e os alertas somem.
// Também retoma <audio> remotos bloqueados pelo autoplay: após reload + auto-rejoin (sem gesto)
// o Chrome pausa todos — sem este play() ninguém ouviria a call até sair e re-entrar.
document.addEventListener('click', () => {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    document.querySelectorAll('audio[id^="audio-"]').forEach((a) => {
      if (a.paused) a.play().catch(() => {});
    });
  } catch { /* som é opcional */ }
}, { capture: true });

async function playSound(name) {
  const seq = SOUNDS[name];
  if (!seq) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    // resume() é assíncrono: agendar antes dele terminar faz o som ser descartado
    if (audioCtx.state !== 'running') await audioCtx.resume();
    const t0 = audioCtx.currentTime;
    seq.forEach(([freq, at, dur]) => {
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(0.18, t0 + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + at + dur);
      osc.connect(g).connect(audioCtx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + dur + 0.05);
    });
  } catch { /* som é opcional */ }
}

// ---------- Login / Registro ----------
// <form> de verdade: Enter envia de qualquer campo e o navegador oferece salvar a senha
$('login-form').onsubmit = (e) => { e.preventDefault(); auth('login'); };
$('register-btn').onclick = () => auth('register');

// Sessão guardada: volta ao servidor sem digitar senha (inclusive depois de um restart)
socket.on('connect', () => {
  const token = localStorage.getItem('hx-token');
  if (!token || username) return;
  socket.emit('resume', { token }, (res) => {
    if (!res || res.error) { localStorage.removeItem('hx-token'); return; }
    enterApp(res);
    const room = sessionStorage.getItem('hx-voice-room');
    if (room) joinVoice(room); // estava numa sala de voz antes da queda: volta pra mesma
  });
});

let currentServerId = null;

function enterApp(res) {
  selfId = res.selfId;
  username = res.username;
  if (res.token) localStorage.setItem('hx-token', res.token);
  renderServerRail(res.servers || [], res.server);
  allNames.clear();
  (res.allUsers || []).forEach((n) => allNames.add(n));
  $('login-screen').classList.add('hidden');
  $('main-screen').classList.remove('hidden');
  // Entrada no app: rail de servidores entra em cascata curta, conteúdo com fade
  if (fx) {
    fx.from('#server-rail .rail-icon', { opacity: 0, y: 10, scale: 0.85, duration: 0.3, ease: 'power2.out', stagger: 0.05, clearProps: 'all' });
    fx.from('.content, .members, .sidebar', { opacity: 0, duration: 0.25, ease: 'power1.out', clearProps: 'opacity' });
  }
  $('self-name').textContent = username;
  applyServerView(res); // canal, mensagens, membros, voz e transmissões do servidor atual
  // Depois do applyServerView: é ele que carrega o mapa de fotos (res.avatars) — antes disso
  // o avatarEl cairia na inicial (foto sumia do rodapé no login por sessão retomada)
  $('self-avatar').replaceChildren(avatarEl(username, 28));
  $('chat-input').focus();
  renderNetStatus();
  maybeSuggestInstall(); // primeiro login neste dispositivo: sugere instalar como app
}

// Monta a tela para o servidor do snapshot (usado no login e ao trocar de servidor)
function applyServerView(res) {
  currentServerId = res.server;
  hidePreview(); // popup de prévia não pode ficar aberto apontando p/ sharer do servidor anterior
  $('server-header').textContent = res.serverName || 'HX';
  document.querySelectorAll('#server-rail .rail-icon').forEach((el) =>
    el.classList.toggle('active', el.id === 'rail-' + res.server));
  avatares.clear();
  Object.entries(res.avatars || {}).forEach(([n, img]) => avatares.set(n, img));
  lastAuthor = null;
  $('messages').replaceChildren();
  $('user-list').replaceChildren();
  onlineNames.clear();
  sharers.clear();
  renderVoiceRooms(res.voiceRooms || []);
  if (inVoice) setActiveRoom(currentRoom); // se minha sala for deste servidor, realça (senão no-op)
  (res.messages || []).forEach(renderMessage);
  (res.users || []).forEach((user) => addUser(user.id, user.username));
  renderOffline();
  (res.voiceUsers || []).forEach((user) => addVoiceUser(user.id, user.username, user.muted, user.deafened, user.room));
  (res.sharers || []).forEach((s) => {
    sharers.set(s.id, { username: s.username, thumb: s.thumb, watchers: s.watchers || [] });
    updateBadge(s.id, true);
  });
  document.querySelector('.content').classList.remove('chat-open'); // troca de servidor volta pro chat
  scrollMessages();
  // Troca de servidor: conteúdo novo entra com fade curto (só opacidade — não mexe no scroll)
  if (fx) fx.from('#messages, #user-list', { opacity: 0, duration: 0.18, ease: 'power1.out', clearProps: 'opacity' });
}

// Barra de servidores (esquerda): ícones com iniciais, clicáveis para trocar
function serverInitials(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.length <= 3 ? name.toUpperCase() : name[0].toUpperCase();
}

let serverList = [];
function serverName(id) {
  return (serverList.find((s) => s.id === id) || {}).name || 'HX';
}

// Ícone de cada servidor (arquivos em public/icons/). Sem o arquivo, cai nas iniciais.
// HX usa o próprio ícone do app; os outros, as fotos escolhidas.
const SERVER_PHOTOS = {
  hx: 'icons/icon-512.png', // logo pixel art (mesmo ícone do app)
  panteras: 'icons/as-panteras-1.jpeg',
  serverb: 'icons/ladyclub.jpg',
};

function renderServerRail(servers, active) {
  serverList = servers;
  const rail = $('server-rail');
  rail.replaceChildren();
  servers.forEach((s) => {
    const el = document.createElement('div');
    el.className = 'rail-icon' + (s.id === active ? ' active' : '');
    el.id = 'rail-' + s.id;
    el.setAttribute('aria-label', s.name); // o tooltip rico mostra o nome; sem title nativo (duplo)
    if (SERVER_PHOTOS[s.id]) {
      const img = document.createElement('img');
      img.className = 'rail-photo';
      img.src = SERVER_PHOTOS[s.id];
      img.alt = s.name;
      img.onerror = () => { el.replaceChildren(); el.textContent = serverInitials(s.name); }; // sem arquivo → iniciais
      el.appendChild(img);
    } else {
      el.textContent = serverInitials(s.name);
    }
    el.onclick = () => { if (s.id !== currentServerId) fxTap(el); switchToServer(s.id); };
    el.onmouseenter = () => showServerTip(s.id, el); // quem está em chamada, ao passar o mouse
    el.onmouseleave = scheduleServerTipHide;
    rail.appendChild(el);
  });
}

// ---------- Tooltip: quem está em chamada no servidor (hover no ícone) ----------
let serverTipFor = null;
let serverTipHideTimer = null;

function showServerTip(serverId, el) {
  clearTimeout(serverTipHideTimer);
  serverTipFor = serverId;
  socket.emit('voice-roster', { server: serverId }, (res) => {
    if (serverTipFor !== serverId || !res || !res.ok) return; // hover mudou / erro
    const tip = $('server-tip');
    const r = el.getBoundingClientRect();
    tip.style.left = (r.right + 10) + 'px';
    tip.style.top = Math.min(r.top, window.innerHeight - 260) + 'px';
    renderServerTip(res);
    const wasHidden = tip.classList.contains('hidden');
    tip.classList.remove('hidden');
    if (wasHidden) fxIn(tip, { y: 0, x: -6, duration: 0.18 }); // deslizar entre ícones não re-anima
  });
}
function scheduleServerTipHide() {
  clearTimeout(serverTipHideTimer);
  serverTipHideTimer = setTimeout(() => { serverTipFor = null; $('server-tip').classList.add('hidden'); }, 150);
}

function renderServerTip(res) {
  const tip = $('server-tip');
  tip.replaceChildren();
  const head = document.createElement('div');
  head.className = 'tip-server';
  head.textContent = serverName(res.server);
  tip.append(head);
  if (!res.users.length) {
    const e = document.createElement('div');
    e.className = 'tip-empty';
    e.textContent = 'Ninguém em chamada';
    tip.append(e);
    return;
  }
  res.rooms.forEach((room) => {
    const inRoom = res.users.filter((u) => u.room === room.id);
    if (!inRoom.length) return;
    const rl = document.createElement('div');
    rl.className = 'tip-room';
    rl.innerHTML = '<svg class="icon"><use href="#i-volume"/></svg>';
    rl.append(' ' + room.name);
    tip.append(rl);
    inRoom.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'tip-user';
      row.append(avatarEl(u.username, 22));
      const nm = document.createElement('span');
      nm.className = 'tip-name';
      nm.textContent = u.username + (u.id === selfId ? ' (você)' : '');
      row.append(nm);
      const ind = document.createElement('span');
      ind.className = 'tip-ind';
      if (u.deafened) ind.innerHTML = '<svg class="icon"><use href="#i-headset-off"/></svg>';
      else if (u.muted) ind.innerHTML = '<svg class="icon"><use href="#i-mic-off"/></svg>';
      row.append(ind);
      tip.append(row);
    });
  });
}

function switchToServer(sid) {
  if (!sid || sid === currentServerId) return;
  socket.emit('switch-server', { server: sid }, (res) => {
    if (!res || res.error) { systemMessage((res && res.error) || 'Falha ao trocar de servidor.'); return; }
    // A voz continua: só troca o que aparece (chat/membros). A call segue rodando por baixo.
    applyServerView(res);
    renderNetStatus();
  });
}

function auth(event) {
  const u = $('username-input').value.trim();
  const p = $('password-input').value;
  if (!u || !p) { $('login-error').textContent = 'Preencha usuário e senha.'; return; }
  $('login-btn').disabled = $('register-btn').disabled = true; // scrypt demora: evita duplo envio
  socket.emit(event, { username: u, password: p }, (res) => {
    $('login-btn').disabled = $('register-btn').disabled = false;
    if (!res || res.error) { $('login-error').textContent = (res && res.error) || 'Falha ao entrar.'; return; }
    enterApp(res);
  });
}


// ---------- Chat ----------
$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  socket.emit('chat-message', { text });
  $('chat-input').value = '';
  closeEmojiPanel();
};

// Agrupamento: mensagens seguidas do mesmo autor em <5min não repetem avatar/nome
let lastAuthor = null;
let lastTs = 0;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentionsMe(text) {
  // Boundary dos dois lados: "admin@ana.com" não é menção a @ana
  return !!username && new RegExp('(?<![\\w])@' + escapeRegex(username) + '(?![\\w])', 'i').test(text);
}

// Memes locais (public/emojis/): shortcode :nome: vira <img> na mensagem
const MEMES = {
  kekw: 'kekw.png', lolcry: 'lolcry.png', pog: 'pog.png', monkas: 'monkas.png',
  sadge: 'sadge.png', gigachad: 'gigachad.png', pepepray: 'pepepray.gif',
  doge: 'doge.png', cooldoge: 'cooldoge.gif', catjam: 'catjam.gif',
  crycat: 'crycat.png', typingcat: 'typingcat.gif', meowparty: 'meowparty.gif',
  nyancat: 'nyancat.gif', pikachu: 'pikachu.png', harold: 'harold.jpg',
  troll: 'troll.png', stonks: 'stonks.png', thisisfine: 'thisisfine.gif',
  dumpsterfire: 'dumpsterfire.gif', panic: 'panic.gif', alert: 'alert.gif',
  facepalm: 'facepalm.png', blinkingguy: 'blinkingguy.gif', homer: 'homer.gif',
  letmein: 'letmein.gif', oldmanyells: 'oldmanyells.png', takemymoney: 'takemymoney.png',
  keanu: 'keanu.gif', micdrop: 'micdrop.gif', this: 'this.gif', rickroll: 'rickroll.gif',
  partyparrot: 'partyparrot.gif', partyblob: 'partyblob.gif', bananadance: 'bananadance.gif',
  sonic: 'sonic.gif',
};
const MEME_RE = /:([a-z0-9]+):/g;

// Texto puro com :shortcode: vira texto + <img> (createElement, nunca innerHTML)
function appendWithEmojis(el, chunk) {
  let last = 0;
  for (const m of chunk.matchAll(MEME_RE)) {
    if (!MEMES[m[1]]) continue;
    if (m.index > last) el.append(chunk.slice(last, m.index));
    const im = document.createElement('img');
    im.className = 'emoji';
    im.src = 'emojis/' + MEMES[m[1]];
    im.alt = im.title = m[0];
    el.appendChild(im);
    last = m.index + m[0].length;
  }
  if (last < chunk.length) el.append(chunk.slice(last));
}

// Links clicáveis: só createElement/append, nunca innerHTML (sem risco de XSS)
function fillText(textDiv, text) {
  textDiv.replaceChildren();
  textDiv.dataset.raw = text; // edição precisa do texto cru (imgs de meme não voltam a shortcode)
  text.split(/(https?:\/\/[^\s]+)/g).forEach((part, i) => {
    if (i % 2) {
      const a = document.createElement('a');
      a.href = part;
      a.textContent = part;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      textDiv.appendChild(a);
    } else if (part) {
      appendWithEmojis(textDiv, part);
    }
  });
  // Mensagem só de memes: mostra grande (como emoji sozinho no Discord)
  textDiv.classList.toggle('jumbo',
    !textDiv.textContent.trim() && !!textDiv.querySelector('.emoji') && textDiv.childElementCount <= 8);
}

function markEdited(div) {
  if (div.querySelector('.edited')) return;
  const tag = document.createElement('span');
  tag.className = 'edited';
  tag.textContent = '(editado)';
  div.querySelector('.text').after(tag);
}

function renderMessage({ id, username: author, text, ts, img, edited }) {
  const compact = author === lastAuthor && ts - lastTs < 5 * 60 * 1000;
  lastAuthor = author;
  lastTs = ts;
  const div = document.createElement('div');
  div.className = compact ? 'message compact' : 'message';
  if (id != null) div.dataset.id = id;
  div.dataset.author = author;
  if (mentionsMe(text) && author !== username) div.classList.add('mention');

  const textDiv = document.createElement('div');
  textDiv.className = 'text';
  fillText(textDiv, text);

  let holder = div; // onde texto/imagem entram (no modo normal é o .body)
  if (!compact) {
    const d = new Date(ts);
    // Histórico pode ter dias: mensagem de outro dia mostra a data junto da hora
    const time = (d.toDateString() === new Date().toDateString() ? ''
      : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ')
      + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const meta = document.createElement('div');
    meta.className = 'meta';
    const authorSpan = document.createElement('span');
    authorSpan.className = 'author';
    authorSpan.textContent = author;
    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = time;
    timeSpan.title = d.toLocaleString('pt-BR');
    meta.append(authorSpan, timeSpan);
    holder = document.createElement('div');
    holder.className = 'body';
    holder.append(meta);
    div.append(avatarEl(author, 36), holder);
  } else {
    div.title = new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  holder.appendChild(textDiv);
  if (edited) markEdited(div);

  if (typeof img === 'string' && img.startsWith('data:image/')) {
    const im = document.createElement('img');
    im.className = 'chat-img';
    im.src = img;
    im.title = 'Clique para ampliar';
    im.onclick = () => im.requestFullscreen?.().catch(() => {});
    // Imagem carrega depois do append e empurra o scroll: cola no fundo se estávamos perto dele
    im.onload = () => {
      const m = $('messages');
      if (m.scrollHeight - m.scrollTop - m.clientHeight < 80 + im.offsetHeight) scrollMessages();
    };
    holder.appendChild(im);
  }

  // Ações (editar/apagar) só nas próprias mensagens
  if (author === username && id != null) {
    const actions = document.createElement('span');
    actions.className = 'msg-actions';
    actions.append(
      tileButton('edit', 'Editar mensagem', () => startEditMessage(div)),
      tileButton('trash', 'Apagar mensagem', () => {
        if (!confirm('Apagar esta mensagem?')) return;
        socket.emit('delete-message', { id }, (res) => {
          if (!res || res.error) systemMessage((res && res.error) || 'Falha ao apagar.');
        });
      })
    );
    div.appendChild(actions);
  }
  $('messages').appendChild(div);
}

// Edição inline: Enter salva, Esc ou clicar fora cancela
function startEditMessage(div) {
  const textDiv = div.querySelector('.text');
  const original = textDiv.dataset.raw ?? textDiv.textContent;
  textDiv.textContent = original; // memes voltam a :shortcode: para editar como texto
  try { textDiv.contentEditable = 'plaintext-only'; } catch { textDiv.contentEditable = 'true'; }
  textDiv.focus();
  const finish = (save) => {
    textDiv.onkeydown = null;
    textDiv.onblur = null;
    textDiv.contentEditable = 'false';
    const t = textDiv.textContent.trim();
    if (!save || !t || t === original) { fillText(textDiv, original); return; }
    socket.emit('edit-message', { id: Number(div.dataset.id), text: t }, (res) => {
      if (!res || res.error) {
        fillText(textDiv, original);
        systemMessage((res && res.error) || 'Falha ao editar.');
      }
    });
  };
  textDiv.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  };
  textDiv.onblur = () => finish(false);
}

socket.on('message-edited', ({ id, text } = {}) => {
  const div = document.querySelector('.message[data-id="' + Number(id) + '"]');
  if (!div || typeof text !== 'string') return;
  fillText(div.querySelector('.text'), text);
  div.classList.toggle('mention', div.dataset.author !== username && mentionsMe(text));
  markEdited(div);
});

socket.on('message-deleted', ({ id } = {}) => {
  const div = document.querySelector('.message[data-id="' + Number(id) + '"]');
  if (!div) return;
  // Mantém o div (pode ser o cabeçalho de um grupo compacto): só troca o conteúdo
  const textDiv = div.querySelector('.text');
  textDiv.replaceChildren();
  const i = document.createElement('i');
  i.className = 'deleted';
  i.textContent = 'mensagem apagada';
  textDiv.appendChild(i);
  div.querySelector('.chat-img')?.remove();
  div.querySelector('.edited')?.remove();
  div.querySelector('.msg-actions')?.remove();
});

function systemMessage(text) {
  lastAuthor = null; // aviso de sistema quebra o agrupamento visual
  const stick = nearBottom();
  const div = document.createElement('div');
  div.className = 'message system';
  div.textContent = text;
  $('messages').appendChild(div);
  fxIn(div, { duration: 0.2 }); // avisos são sempre eventos ao vivo — pode animar
  if (stick) { scrollMessages(); trimMessages(); }
}

function scrollMessages() {
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}

// Só rola sozinho se o usuário já estava no fundo — não rouba a posição de quem lê o histórico
function nearBottom() {
  const m = $('messages');
  return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
}

// Aba em segundo plano: contador no título + som de alerta
let unread = 0;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    unread = 0;
    document.title = 'HX Chat';
  }
});

// DOM com teto: sessão aberta por dias não acumula milhares de divs (histórico do servidor é 100)
const MAX_DOM_MESSAGES = 300;
function trimMessages() {
  const m = $('messages');
  while (m.children.length > MAX_DOM_MESSAGES) m.firstChild.remove();
}

socket.on('chat-message', (msg) => {
  const stick = nearBottom() || msg.username === username; // mensagem própria sempre rola
  renderMessage(msg);
  fxIn($('messages').lastElementChild); // só mensagem ao vivo anima; histórico entra pronto
  if (stick) { scrollMessages(); trimMessages(); }
  clearTyping(msg.username); // a mensagem chegou: some o "está digitando"
  const mentioned = msg.username !== username && mentionsMe(msg.text);
  if (document.hidden && msg.username !== username) {
    unread++;
    document.title = '(' + unread + ') HX Chat';
    playSound('notify');
  } else if (mentioned) {
    playSound('notify'); // @menção toca mesmo com a aba visível
  }
});

// Mensagem cortada pelo anti-flood não pode sumir muda
let lastRateWarn = 0;
socket.on('rate-limited', ({ event } = {}) => {
  if (event !== 'chat-message' || Date.now() - lastRateWarn < 3000) return;
  lastRateWarn = Date.now();
  systemMessage('Você está enviando mensagens rápido demais — aguarde um instante.');
});

// Colar print (Ctrl+V) no campo de mensagem envia a imagem
$('chat-input').addEventListener('paste', async (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  if (!file) return;
  let img;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    img = canvas.toDataURL('image/jpeg', 0.8);
    if (img.length > 200 * 1024) img = canvas.toDataURL('image/jpeg', 0.6);
    if (img.length > 200 * 1024) { systemMessage('Imagem grande demais.'); return; }
  } catch {
    systemMessage('Não consegui ler essa imagem.');
    return;
  }
  socket.emit('chat-message', { text: $('chat-input').value.trim(), img });
  $('chat-input').value = '';
});

// ---------- Seletor de emojis ----------
// Uma grade rolável: memes primeiro, depois emojis Unicode por categoria
const EMOJI_CATS = [
  ['Carinhas', '😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫡 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😮 😲 🥱 😴 🤤 😪 😵 😵‍💫 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 🤡 💩 👻 💀 👽 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾'],
  ['Gestos', '👋 🤚 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 💪 🖕 💅 🫵'],
  ['Corações', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💤'],
  ['Bichos', '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🦆 🦅 🦉 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🕷️ 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦀 🐡 🐠 🐟 🐬 🐳 🦈 🐊'],
  ['Comida', '🍏 🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🌽 🥕 🍞 🥐 🧀 🥚 🍳 🥞 🥓 🥩 🍗 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍣 🍱 🍤 🍚 🍦 🍩 🍪 🎂 🍰 🧁 🍫 🍬 🍭 🍿 ☕ 🍵 🥤 🍺 🍻 🥂 🍷 🥃 🍸 🍹'],
  ['Coisas', '⚽ 🏀 🏈 🎾 🎱 🏓 🎮 🕹️ 🎲 🎯 🎳 🎸 🎹 🥁 🎤 🎧 🎬 🎨 🚗 ✈️ 🚀 ⏰ 🔥 ✨ 🌟 ⭐ 🌈 ☀️ 🌙 ⚡ ❄️ ☔ 💰 💎 🔨 🛠️ 🔑 🔒 📱 💻 ⌨️ 📷 🔋 💡 📌 ✏️ 📚 🎁 🎈 🎉 🎊 🏆 🥇 🥈 🥉 🚩 🏁'],
];

let emojiBuilt = false;
function buildEmojiPanel() {
  if (emojiBuilt) return;
  emojiBuilt = true;
  const grid = $('emoji-grid');
  const section = (label) => {
    const h = document.createElement('div');
    h.className = 'emoji-cat';
    h.textContent = label;
    const row = document.createElement('div');
    row.className = 'emoji-row';
    grid.append(h, row);
    return row;
  };
  const memeRow = section('Memes');
  for (const [name, file] of Object.entries(MEMES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = ':' + name + ':';
    b.dataset.insert = ':' + name + ':';
    const im = document.createElement('img');
    im.src = 'emojis/' + file;
    im.alt = ':' + name + ':';
    im.loading = 'lazy';
    b.appendChild(im);
    memeRow.appendChild(b);
  }
  for (const [label, chars] of EMOJI_CATS) {
    const row = section(label);
    for (const ch of chars.split(' ')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = ch;
      b.dataset.insert = ch;
      row.appendChild(b);
    }
  }
  grid.onclick = (e) => {
    const b = e.target.closest('button[data-insert]');
    if (!b) return;
    const inp = $('chat-input');
    inp.focus();
    const s = inp.selectionStart ?? inp.value.length;
    inp.setRangeText(b.dataset.insert, s, inp.selectionEnd ?? s, 'end');
  };
}

function closeEmojiPanel() { $('emoji-panel').classList.add('hidden'); }

$('emoji-btn').onclick = () => {
  const panel = $('emoji-panel');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  if (opening) {
    buildEmojiPanel();
    fxIn(panel, { y: 8, duration: 0.18 });
    $('chat-input').focus();
  }
};

// Fecha ao clicar fora ou apertar Esc
document.addEventListener('click', (e) => {
  if (!$('emoji-panel').classList.contains('hidden')
    && !e.target.closest('#emoji-panel') && !e.target.closest('#emoji-btn')) closeEmojiPanel();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeEmojiPanel();
});

// ---------- "Fulano está digitando…" ----------
const typingUsers = new Map(); // nome -> timeout de expiração
let lastTypingSent = 0;

$('chat-input').addEventListener('input', () => {
  const now = Date.now();
  if ($('chat-input').value && now - lastTypingSent > 2000) {
    lastTypingSent = now;
    socket.emit('typing');
  }
});

socket.on('typing', ({ username: name } = {}) => {
  if (typeof name !== 'string' || name === username) return;
  clearTimeout(typingUsers.get(name));
  typingUsers.set(name, setTimeout(() => clearTyping(name), 3500));
  renderTyping();
});

function clearTyping(name) {
  clearTimeout(typingUsers.get(name));
  if (typingUsers.delete(name)) renderTyping();
}

function renderTyping() {
  const names = [...typingUsers.keys()];
  $('typing-line').textContent =
    names.length === 0 ? '' :
    names.length === 1 ? names[0] + ' está digitando…' :
    names.length === 2 ? names[0] + ' e ' + names[1] + ' estão digitando…' :
    names.length + ' pessoas estão digitando…';
}

// ---------- Lista de usuários (Online + Offline, como no Discord) ----------
const allNames = new Set();    // toda conta registrada
const onlineNames = new Set(); // quem está conectado agora

function addUser(id, name) {
  if (document.getElementById('user-' + id)) return;
  const li = document.createElement('li');
  li.id = 'user-' + id;
  const span = document.createElement('span');
  span.textContent = name;
  li.append(avatarEl(name, 26), span);
  $('user-list').appendChild(li);
  allNames.add(name);
  onlineNames.add(name);
}

function renderOffline() {
  $('online-label').textContent = 'Online — ' + onlineNames.size;
  const off = [...allNames].filter((n) => !onlineNames.has(n)).sort((a, b) => a.localeCompare(b));
  $('offline-label').textContent = 'Offline — ' + off.length;
  $('offline-label').classList.toggle('hidden', off.length === 0);
  $('offline-list').replaceChildren(...off.map((n) => {
    const li = document.createElement('li');
    li.className = 'offline';
    const span = document.createElement('span');
    span.textContent = n;
    li.append(avatarEl(n, 26), span);
    return li;
  }));
}

socket.on('user-joined', ({ id, username: name, avatar }) => {
  if (typeof avatar === 'string') { avatares.set(name, avatar); refreshAvatars(name); }
  addUser(id, name);
  fxIn($('user-' + id), { y: 4, duration: 0.2 });
  renderOffline();
});

socket.on('user-left', ({ id, username: name }) => {
  fxOut(document.getElementById('user-' + id));
  // NÃO derruba voz/peer/live aqui: trocar de servidor (só a vista) também emite user-left,
  // e a pessoa continua na call. Saída real da voz chega via 'voice-user-left'.
  onlineNames.delete(name);
  clearTyping(name); // "está digitando…" de quem saiu não fica pendurado
  renderOffline();
  // Libera a foto da memória se não está mais em nenhum avatar renderizado
  if (name && !document.querySelector('.avatar[data-name="' + CSS.escape(name) + '"]')) avatares.delete(name);
});

// ---------- Canal de voz (UI) ----------
let inVoice = false;
let currentRoom = null;   // id da sala de voz atual (null = fora da voz)
let voiceRooms = [];      // [{id, name}] recebidas do servidor
let localStream = null;   // microfone
let micMonitor = null;    // clone do mic só para medir nível (imune ao gate do VAD)
let screenStream = null;  // tela

// Renderiza as salas de voz (fonte é o servidor): cada sala é um canal clicável + lista de gente
function renderVoiceRooms(rooms) {
  voiceRooms = rooms;
  const box = $('voice-rooms');
  box.replaceChildren();
  rooms.forEach((room) => {
    const ch = document.createElement('div');
    ch.className = 'channel';
    ch.id = 'voice-room-' + room.id;
    ch.innerHTML = '<svg class="icon"><use href="#i-volume"/></svg>';
    ch.append(' ' + room.name);
    ch.title = 'Entrar em ' + room.name;
    ch.onclick = () => joinVoice(room.id);
    const ul = document.createElement('ul');
    ul.className = 'voice-users';
    ul.id = 'voice-users-' + room.id;
    box.append(ch, ul);
  });
}

function voiceRoomName(id) {
  return (voiceRooms.find((r) => r.id === id) || {}).name || id;
}
const peers = new Map();         // peerId -> { pc, makingOffer, ignoreOffer, polite }
const sharers = new Map();       // sharerId -> { username, thumb }
const watching = new Set();      // sharerIds que estou assistindo
const viewerSenders = new Map(); // viewerId -> RTCRtpSender do meu vídeo de tela
const screenStreams = new Map(); // sharerId -> MediaStream da tela dele (cache p/ re-assistir sem novo ontrack)

function addVoiceUser(id, name, muted = false, deafened = false, room = currentRoom) {
  const ul = document.getElementById('voice-users-' + room);
  if (!ul) return; // sala desconhecida
  document.getElementById('voice-user-' + id)?.remove(); // pode estar noutra sala: recoloca
  const li = document.createElement('li');
  li.id = 'voice-user-' + id;
  const span = document.createElement('span');
  span.className = 'name';
  span.textContent = name;
  const muteInd = document.createElement('span');
  muteInd.className = 'mute-ind';
  muteInd.title = 'Mutado';
  muteInd.innerHTML = '<svg class="icon"><use href="#i-mic-off"/></svg>';
  const deafInd = document.createElement('span');
  deafInd.className = 'deaf-ind';
  deafInd.title = 'Silenciado';
  deafInd.innerHTML = '<svg class="icon"><use href="#i-headset-off"/></svg>';
  li.append(avatarEl(name, 24), span, muteInd, deafInd);
  li.title = 'Ver perfil';
  // Perfil do participante (foto, membro desde, volume) — nome lido do DOM: sobrevive a rename
  li.onclick = () => openUserProfile(id, li.querySelector('.name').textContent);
  li.classList.toggle('muted', muted);
  li.classList.toggle('deafened', deafened);
  ul.appendChild(li);
  if (sharers.has(id)) updateBadge(id, true);
}

function setVoiceMuted(id, muted) {
  document.getElementById('voice-user-' + id)?.classList.toggle('muted', !!muted);
}

socket.on('user-muted', ({ id, muted } = {}) => setVoiceMuted(id, muted));

function setVoiceDeafened(id, deafened) {
  document.getElementById('voice-user-' + id)?.classList.toggle('deafened', !!deafened);
}

socket.on('user-deafened', ({ id, deafened } = {}) => setVoiceDeafened(id, deafened));

function removeVoiceUser(id) {
  fxOut(document.getElementById('voice-user-' + id));
  removeScreenTile(id);
}

function voiceUserName(id) {
  return document.querySelector('#voice-user-' + CSS.escape(id) + ' .name')?.textContent
    || sharers.get(id)?.username || 'Tela';
}

$('leave-voice-btn').onclick = leaveVoice;
$('mute-btn').onclick = toggleMute;
$('deafen-btn').onclick = toggleDeafen;
$('screen-btn').onclick = toggleScreen;

// ---------- Modo de entrada do microfone: automático (VAD) ou push-to-talk ----------
let pttOn = localStorage.getItem('hx-ptt') === 'on';
let pttKey = localStorage.getItem('hx-ptt-key') || 'Backquote';
let vadEnabled = localStorage.getItem('hx-vad') === 'on';
let vadThreshold = Math.min(100, Math.max(0, +(localStorage.getItem('hx-vad-threshold') ?? 20))); // 0-100

$('ptt-toggle').onchange = () => {
  pttOn = $('ptt-toggle').checked;
  localStorage.setItem('hx-ptt', pttOn ? 'on' : 'off');
  $('ptt-key-row').classList.toggle('hidden', !pttOn);
  if (pttOn && vadEnabled) { vadEnabled = false; localStorage.setItem('hx-vad', 'off'); syncInputUi(); } // exclusivos
  applyMic();
};

$('vad-toggle').onchange = () => {
  vadEnabled = $('vad-toggle').checked;
  localStorage.setItem('hx-vad', vadEnabled ? 'on' : 'off');
  $('vad-row').classList.toggle('hidden', !vadEnabled);
  if (vadEnabled && pttOn) { pttOn = false; localStorage.setItem('hx-ptt', 'off'); syncInputUi(); } // exclusivos
  applyMic();
};

$('vad-threshold').oninput = () => {
  vadThreshold = +$('vad-threshold').value;
  localStorage.setItem('hx-vad-threshold', vadThreshold);
  $('vad-marker').style.left = vadThreshold + '%';
};

// Reflete no perfil os estados de PTT/VAD (usado ao abrir e ao alternar exclusivos)
function syncInputUi() {
  $('ptt-toggle').checked = pttOn;
  $('ptt-key-row').classList.toggle('hidden', !pttOn);
  $('ptt-key').value = pttKey;
  $('vad-toggle').checked = vadEnabled;
  $('vad-row').classList.toggle('hidden', !vadEnabled);
  $('vad-threshold').value = vadThreshold;
  $('vad-marker').style.left = vadThreshold + '%';
}

$('ptt-key').onkeydown = (e) => {
  e.preventDefault();
  e.stopPropagation();
  pttKey = e.code;
  localStorage.setItem('hx-ptt-key', pttKey);
  $('ptt-key').value = pttKey;
  $('ptt-key').blur();
};

// Atalhos: Esc fecha modais; Ctrl+Shift+M muta; Ctrl+Shift+D silencia (como no Discord)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('profile-overlay').classList.add('hidden');
    closeUserProfile();
    hidePreview();
  } else if (e.ctrlKey && e.shiftKey && e.code === 'KeyM') {
    e.preventDefault();
    toggleMute();
  } else if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
    e.preventDefault();
    toggleDeafen();
  } else if (pttOn && inVoice && !deafened && e.code === pttKey && !e.repeat && !isTypingTarget(e.target)) {
    pttHeld = true; applyMic(); // tecla pressionada: fala
  }
});

document.addEventListener('keyup', (e) => {
  if (pttOn && inVoice && e.code === pttKey && !isTypingTarget(e.target)) { pttHeld = false; applyMic(); }
});

// PTT não dispara enquanto se digita (tecla configurada como Enter/letra escreveria E mutaria)
function isTypingTarget(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

// Menu hambúrguer (mobile): sidebar vira gaveta
$('menu-btn').onclick = (e) => {
  e.stopPropagation(); // o clique no content fecharia a gaveta que acabou de abrir
  document.querySelector('.sidebar').classList.toggle('open');
};
document.querySelector('.content').addEventListener('click', () => {
  document.querySelector('.sidebar').classList.remove('open');
});

let joiningVoice = false;

async function joinVoice(room) {
  if (!room || room === currentRoom || joiningVoice) return; // já nesta sala ou entrando
  joiningVoice = true;
  try {
    if (!localStream) { // pede o mic só na primeira entrada; trocar de sala reaproveita
      localStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
    }
  } catch (err) {
    joiningVoice = false;
    systemMessage('Sem acesso ao microfone: ' + err.message);
    return;
  }
  socket.emit('join-voice', { room }, (res) => {
    joiningVoice = false;
    if (!res || res.error) {
      if (!currentRoom) { localStream?.getTracks().forEach((t) => t.stop()); localStream = null; }
      // Sala não existe mais (ex.: removida do servidor): não insistir no auto-rejoin ao recarregar
      if (/inválida/i.test((res && res.error) || '')) sessionStorage.removeItem('hx-voice-room');
      systemMessage((res && res.error) || 'Falha ao entrar no canal de voz.');
      return;
    }
    // Só derruba o mesh antigo depois do ack: erro na troca não deixa a call em limbo
    if (currentRoom && currentRoom !== res.room) teardownVoiceMesh();
    inVoice = true;
    currentRoom = res.room;
    setActiveRoom(res.room);
    $('voice-controls').classList.remove('hidden');
    addVoiceUser(selfId, username, manualMuted, deafened, res.room);
    // Medidor lê um CLONE do mic (sempre vivo), senão o gate do VAD fecharia o track e cegaria o medidor
    if (!meters.has(selfId)) {
      micMonitor = new MediaStream([localStream.getAudioTracks()[0].clone()]);
      attachSpeaking(selfId, micMonitor);
    }
    applyMic(); // estado inicial do mic (PTT/VAD fecham; senão abre, salvo mute)
    playSound('userJoin'); // toca também para quem entrou, não só para quem já estava
    sessionStorage.setItem('hx-voice-room', res.room); // volta pra mesma sala sozinho se cair
    // Novato inicia a conexão com cada participante já presente na sala
    res.peers.forEach(({ id }) => getPeer(id));
    if (previewId) updatePreview();
    renderNetStatus();
  });
}

function setActiveRoom(room) {
  document.querySelectorAll('#voice-rooms .channel').forEach((c) => c.classList.remove('active'));
  document.getElementById('voice-room-' + room)?.classList.add('active');
}

// Troca de sala: fecha as conexões da sala atual mas preserva o microfone e a UI de controles
function teardownVoiceMesh() {
  if (screenStream) stopScreen(false, 'trocou de sala de voz');
  watching.forEach((id) => removeScreenTile(id));
  watching.clear();
  viewerSenders.clear();
  peers.forEach((_, id) => removePeer(id));
  removeVoiceUser(selfId); // sai da lista da sala antiga (o servidor troca sozinho no join)
}

function leaveVoice() {
  if (!inVoice) return;
  inVoice = false;
  currentRoom = null;
  setActiveRoom(null);
  sessionStorage.removeItem('hx-voice-room');
  if (screenStream) stopScreen(false, 'saiu do canal de voz');
  socket.emit('leave-voice');
  watching.forEach((id) => removeScreenTile(id));
  watching.clear();
  viewerSenders.clear();
  [...meters.keys()].forEach(detachSpeaking);
  peers.forEach((_, id) => removePeer(id));
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  micMonitor?.getTracks().forEach((t) => t.stop());
  micMonitor = null;
  pttHeld = false; vadOpen = false;
  $('voice-controls').classList.add('hidden');
  removeVoiceUser(selfId);
  manualMuted = false;
  $('mute-btn').classList.remove('active');
  $('mute-btn').setAttribute('aria-pressed', false);
  $('mute-icon').setAttribute('href', '#i-mic');
  deafened = false;
  $('deafen-btn').classList.remove('active');
  $('deafen-btn').setAttribute('aria-pressed', false);
  $('deafen-icon').setAttribute('href', '#i-headset');
  playSound('leave');
  if (previewId) updatePreview();
  renderNetStatus();
}

let deafened = false;
let manualMuted = false;       // botão de mute (mic-off visível aos outros) — fonte da verdade do mute
let mutedBeforeDeafen = false; // mute explícito anterior ao deafen: preservado ao sair (como no Discord)
let pttHeld = false;           // tecla de push-to-talk pressionada agora
let vadOpen = false;           // gate do VAD aberto agora (setado pelo medidor)

// Decide se o mic transmite, combinando mute/deafen/push-to-talk/VAD numa fonte só
function micShouldBeOpen() {
  if (manualMuted || deafened || !inVoice) return false;
  if (pttOn) return pttHeld;       // push-to-talk: só com a tecla
  if (vadEnabled) return vadOpen;  // sensibilidade automática: só quando detecta fala
  return true;                     // aberto o tempo todo
}

// Aplica o estado calculado ao track do microfone (só o toque final em track.enabled)
function applyMic() {
  const track = localStream?.getAudioTracks()[0];
  if (track) { const open = micShouldBeOpen(); if (track.enabled !== open) track.enabled = open; }
}

// Mute manual (botão): mostra o ícone mic-off para todos e emite. O gate do VAD NÃO passa por aqui.
function setMuted(muted, sound = true) {
  if (manualMuted === muted) return;
  manualMuted = muted;
  $('mute-btn').classList.toggle('active', muted);
  $('mute-btn').setAttribute('aria-pressed', muted);
  $('mute-icon').setAttribute('href', muted ? '#i-mic-off' : '#i-mic');
  setVoiceMuted(selfId, muted);
  socket.emit('set-muted', { muted });
  applyMic();
  if (sound) playSound(muted ? 'mute' : 'unmute');
}

function toggleMute() {
  if (!localStream) return;
  fxTap($('mute-btn'));
  // Clicar no mic estando silenciado = quero falar: sai do deafen com o mic aberto
  if (deafened) { mutedBeforeDeafen = false; toggleDeafen(); return; }
  setMuted(!manualMuted);
}

// Silenciar o canal: para de ouvir todo mundo e também fecha o próprio microfone
function toggleDeafen() {
  if (!inVoice) return;
  fxTap($('deafen-btn'));
  deafened = !deafened;
  document.querySelectorAll('audio[id^="audio-"]').forEach((a) => { a.muted = deafened; });
  // Silenciado também cala as lives dos outros — via applyMute de cada tile: o ícone de volume
  // acompanha e o mudo manual do tile é respeitado ao des-silenciar (a própria tela não tem handler)
  document.querySelectorAll('.screen-tile video').forEach((v) => v._applyMute?.());
  $('deafen-btn').classList.toggle('active', deafened);
  $('deafen-btn').setAttribute('aria-pressed', deafened);
  $('deafen-icon').setAttribute('href', deafened ? '#i-headset-off' : '#i-headset');
  setVoiceDeafened(selfId, deafened);
  socket.emit('set-deafened', { deafened });
  // Deafen implica mute (mostra mic-off também); ao sair, devolve o mute anterior
  if (deafened) { mutedBeforeDeafen = manualMuted; setMuted(true, false); }
  else setMuted(mutedBeforeDeafen, false);
  applyMic();
  playSound(deafened ? 'mute' : 'unmute');
}

socket.on('voice-user-joined', ({ id, username: name, room }) => {
  addVoiceUser(id, name, false, false, room);
  fxIn($('voice-user-' + id), { y: 4, duration: 0.2 });
  if (inVoice && room === currentRoom) playSound('userJoin'); // só alerta se for na minha sala
  // Conexão criada sob demanda quando a oferta do novato chegar
});

socket.on('voice-user-left', ({ id }) => {
  if (id === selfId) { leaveVoice(); return; } // sessão substituída em outra aba: limpa meu estado
  removeVoiceUser(id);
  removePeer(id);
  sharerGone(id);
  if (inVoice) playSound('userLeave');
});

// ---------- Qualidade de rede (ping) + indicador de servidor/canal ----------
let pingMs = null;

function renderNetStatus() {
  const sig = $('net-signal');
  if (!sig) return;
  sig.classList.remove('good', 'ok', 'bad');
  if (!socket.connected) sig.title = 'Sem conexão com o servidor HX';
  else if (pingMs == null) sig.title = 'Medindo latência com o servidor HX…';
  else {
    sig.classList.add(pingMs < 100 ? 'good' : pingMs < 250 ? 'ok' : 'bad');
    sig.title = pingMs + ' ms — latência da sua rede com o servidor HX';
  }
  const sharing = !!screenStream;
  const line1 = $('net-line1');
  line1.textContent = !socket.connected ? 'Reconectando…'
    : sharing ? 'Transmitindo tela'
    : inVoice ? 'Voz conectada'
    : 'Online';
  line1.classList.toggle('voice', socket.connected && (inVoice || sharing));
  $('net-line2').textContent = serverName(currentServerId) + ' · ' + (inVoice && currentRoom ? voiceRoomName(currentRoom) : '# geral');
}

function measurePing() {
  if (!socket.connected) { pingMs = null; renderNetStatus(); return; }
  const t0 = performance.now();
  try {
    socket.timeout(4000).emit('ping-hx', (err) => {
      pingMs = err ? null : Math.round(performance.now() - t0);
      renderNetStatus();
    });
  } catch { /* cliente sem socket.timeout: sem medição, indicador fica neutro */ }
}
setInterval(measurePing, 5000);
socket.on('connect', () => { measurePing(); renderNetStatus(); });
socket.on('disconnect', () => { pingMs = null; renderNetStatus(); });

// ---------- Tratamento do microfone (redução de ruído estilo Discord) ----------
let noiseSuppression = localStorage.getItem('hx-noise') !== 'off';

function micConstraints() {
  return {
    noiseSuppression,          // filtra ventilador, ar-condicionado, chiado
    echoCancellation: true,    // evita retorno do som dos outros pelo alto-falante
    autoGainControl: true,     // normaliza volume da voz
    channelCount: 1,
    ...(noiseSuppression ? { googNoiseSuppression: true, googHighpassFilter: true } : {}),
  };
}

async function applyMicSettings() {
  noiseSuppression = $('noise-toggle').checked;
  localStorage.setItem('hx-noise', noiseSuppression ? 'on' : 'off');
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints(micConstraints()); // troca em tempo real, sem recriar a conexão
    $('profile-ok').textContent = noiseSuppression ? 'Redução de ruído ativada.' : 'Redução de ruído desativada.';
    setTimeout(() => { $('profile-ok').textContent = ''; }, 2500);
  } catch {
    $('profile-error').textContent = 'Seu navegador não permitiu alterar o filtro agora.';
  }
}

// ---------- Detecção de fala (contorno verde no avatar) ----------
const meters = new Map(); // id -> { analyser, data, src }
let meterTimer = null;

function attachSpeaking(id, stream) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser); // analyser não vai ao destination: só medição, sem eco
    meters.set(id, { analyser, data: new Uint8Array(analyser.frequencyBinCount), src, speaking: false, lastLoud: 0 });
    if (!meterTimer) meterTimer = setInterval(pollSpeaking, 100);
  } catch { /* medidor é opcional */ }
}

function detachSpeaking(id) {
  const m = meters.get(id);
  if (!m) return;
  meters.delete(id);
  try { m.src.disconnect(); } catch { /* já desconectado */ }
  voiceAvatar(id)?.classList.remove('speaking');
  if (!meters.size && meterTimer) { clearInterval(meterTimer); meterTimer = null; }
}

function voiceAvatar(id) {
  return document.querySelector('#voice-user-' + CSS.escape(id) + ' .avatar');
}

// Histerese + hold: liga acima de ON, só desliga abaixo de OFF e após HOLD_MS de silêncio.
// Evita o pisca-pisca nas pausas naturais da fala; o fade do CSS completa a saída suave.
const SPEAK_ON = 5;
const SPEAK_OFF = 3;
const SPEAK_HOLD_MS = 1200;
const VAD_MAX_RMS = 32; // topo da escala do medidor: mapeia o slider 0-100 para o limiar de RMS

// Limiar do VAD em RMS, a partir do slider 0-100 (mesma escala do medidor no perfil)
function vadOnLevel() { return 1 + (vadThreshold / 100) * VAD_MAX_RMS; }

function pollSpeaking() {
  const now = performance.now();
  const gateOn = vadOnLevel();
  meters.forEach((m, id) => {
    m.analyser.getByteTimeDomainData(m.data);
    let sum = 0;
    for (const v of m.data) { const d = v - 128; sum += d * d; }
    const level = Math.sqrt(sum / m.data.length);
    m.level = level; // exposto para o medidor do perfil

    // No meu próprio avatar com VAD ligado, o contorno verde usa o MESMO limiar do gate (sincronizados)
    const selfVad = id === selfId && vadEnabled && inVoice && !deafened;
    const onL = selfVad ? gateOn : SPEAK_ON;
    const offL = selfVad ? gateOn * 0.7 : SPEAK_OFF;

    if (level > onL) m.lastLoud = now;
    let speaking = m.speaking
      ? (level > offL || now - (m.lastLoud || 0) < SPEAK_HOLD_MS)
      : level > onL;

    // Gate do VAD: usa a detecção crua (fala), mas só abre se eu não estiver mutado/silenciado
    if (id === selfId && vadEnabled && !pttOn) { vadOpen = speaking && !manualMuted && !deafened; applyMic(); }

    // Contorno verde só quando o mic REALMENTE transmite: mutado/silenciado/PTT-solto/gate-fechado = sem verde
    if (id === selfId && !micShouldBeOpen()) speaking = false;

    if (speaking !== m.speaking) {
      m.speaking = speaking;
      voiceAvatar(id)?.classList.toggle('speaking', speaking);
    }
  });
}

// ---------- WebRTC mesh (negociação perfeita) ----------
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
// ponytail: só STUN; atrás de NAT simétrico precisa de TURN — adicionar credenciais aqui

function getPeer(peerId) {
  if (peers.has(peerId)) return peers.get(peerId);

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const state = {
    pc,
    makingOffer: false,
    ignoreOffer: false,
    settingRemoteAnswer: false, // negociação perfeita canônica: sem isto, offer legítima vira "colisão"
    polite: selfId < peerId,
    screenSender: null,         // sender de vídeo da tela, reutilizado via replaceTrack (m-lines não crescem)
    screenAudioSender: null,    // sender de áudio da tela (se o transmissor compartilhou som)
    restarts: 0,                // limite de ICE restart: só STUN, par inalcançável não loopa para sempre
  };
  peers.set(peerId, state);

  localStream?.getTracks().forEach((t) => pc.addTrack(t, localStream));
  // Tela NÃO é adicionada aqui: vídeo só vai para quem pedir para assistir (watch)

  pc.onnegotiationneeded = async () => {
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      socket.emit('signal', { to: peerId, data: { description: pc.localDescription } });
    } catch (err) {
      console.error(err);
    } finally {
      state.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('signal', { to: peerId, data: { candidate } });
  };

  pc.ontrack = ({ track, streams }) => {
    // A tela é enviada com vídeo + áudio no MESMO stream (screenStream). O mic vai num stream só-áudio.
    // Ordem determinística: mic entra no pc na criação (m-line 0); no watch adiciono vídeo ANTES do
    // áudio numa única renegociação, então o navegador entrega ontrack em ordem de m-line
    // (mic → vídeo → áudio-da-tela). Quando o áudio da tela chega, o stream já tem o vídeo.
    const stream = streams[0] || new MediaStream([track]);
    const isScreen = stream.getVideoTracks().length > 0;
    if (track.kind === 'video') {
      screenStreams.set(peerId, stream); // guarda p/ re-assistir: replaceTrack não dispara novo ontrack
      if (!watching.has(peerId)) return; // unwatch venceu a corrida com a renegociação
      addScreenTile(peerId, stream); // stream com vídeo E áudio da live: o som toca no próprio <video>
      track.onended = () => removeScreenTile(peerId);
      // sem onmute: mute é transitório (janela minimizada, rede) — fim real chega via evento 'screen-share'
    } else if (isScreen) {
      // áudio da live: já vem no mesmo stream do vídeo, tocando no <video> do tile — nada a fazer
    } else {
      const micStream = new MediaStream([track]);
      const audio = new Audio();
      audio.srcObject = micStream;
      audio.autoplay = true;
      audio.muted = deafened; // quem chega durante o modo silenciado também fica mudo
      audio.volume = (localStorage.getItem('hx-vol-' + voiceUserName(peerId)) ?? 100) / 100;
      audio.id = 'audio-' + peerId;
      document.body.appendChild(audio);
      attachSpeaking(peerId, micStream);
    }
  };

  // Par morto de verdade (fechou a aba/caiu): o evento de saída pode nunca chegar (ex.: vista em
  // outro servidor). Sem esta limpeza, sobra tile preto + badge fantasma + watching preso — e
  // re-assistir a pessoa quando ela volta não funciona.
  const peerDead = () => {
    if (pc.connectionState === 'connected') return;
    removeVoiceUser(peerId); // some da sala (e o tile via removeScreenTile)
    sharerGone(peerId);      // badge/preview/watching/stream em cache
    removePeer(peerId);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') { state.restarts = 0; clearTimeout(state.deadTimer); }
    else if (pc.connectionState === 'failed') {
      if (++state.restarts <= 3) {
        pc.restartIce(); // re-oferta flui pela negociação perfeita
        clearTimeout(state.deadTimer);
        state.deadTimer = setTimeout(peerDead, 8000); // restart sem sucesso em 8s = par morto
      } else {
        systemMessage('Não foi possível conectar com ' + voiceUserName(peerId) + ' (rede restritiva).');
        peerDead();
      }
    } else if (pc.connectionState === 'closed') removePeer(peerId);
  };

  // Negociação fechou: aplica bitrate/degradation nos senders (substitui o retry cego de 2s)
  pc.onsignalingstatechange = () => {
    if (pc.signalingState === 'stable') retuneSenders();
  };

  return state;
}

function removePeer(peerId) {
  const state = peers.get(peerId);
  if (!state) return;
  clearTimeout(state.deadTimer); // watchdog de par morto não pode disparar após a limpeza
  peers.delete(peerId);
  if (viewerSenders.delete(peerId)) retuneSenders(); // espectador caiu: redistribui banda
  watching.delete(peerId);
  screenStreams.delete(peerId); // pc fechado: o stream em cache não vale mais
  detachSpeaking(peerId);
  state.pc.close();
  document.getElementById('audio-' + peerId)?.remove();
  removeScreenTile(peerId);
}

socket.on('signal', async ({ from, data }) => {
  if (!inVoice) return;
  const state = getPeer(from);
  const { pc } = state;
  try {
    if (data.description) {
      // readyForOffer inclui settingRemoteAnswer: enquanto a answer anterior aplica, o estado
      // ainda é have-local-offer — sem a flag, a offer legítima seguinte seria descartada e o
      // peer polido ficaria preso (nenhuma renegociação futura funcionaria)
      const readyForOffer = !state.makingOffer &&
        (pc.signalingState === 'stable' || state.settingRemoteAnswer);
      const offerCollision = data.description.type === 'offer' && !readyForOffer;
      state.ignoreOffer = !state.polite && offerCollision;
      if (state.ignoreOffer) return;
      state.settingRemoteAnswer = data.description.type === 'answer';
      await pc.setRemoteDescription(data.description);
      state.settingRemoteAnswer = false;
      if (data.description.type === 'offer') {
        await pc.setLocalDescription();
        socket.emit('signal', { to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!state.ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.error('Erro de sinalização:', err);
  }
});

// ---------- Compartilhamento de tela (transmissor) ----------
let screenPending = false;
let thumbTimer = null;

// ---------- SFU (mediasoup): live sobe UMA vez pro servidor, que replica aos espectadores ----------
// Corta o custo no PC do transmissor: 1 encode + 1 upload, independente de quantos assistem.
// Qualquer falha aqui cai no P2P mesh de sempre (fallback silencioso).
let sfuDevice = null;   // Device carregado (false = SFU indisponível nesta sessão)
let sfuSend = null;     // transporte de envio (minha live)
let sfuRecv = null;     // transporte de recepção (lives que assisto)
let sfuLive = false;    // minha live está publicada no SFU (gate do fallback P2P)
let sfuProducers = [];
const sfuConsumers = new Map(); // sharerId -> [Consumer]

// Ack com prazo: servidor antigo/sem handler não responde — sem isto o await penduraria o fluxo
function sfuAck(event, payload) {
  return new Promise((r) => socket.timeout(4000).emit(event, payload, (err, res) => r(err ? null : res)));
}

async function sfuInit() {
  if (sfuDevice !== null) return sfuDevice;
  if (!window.mediasoupClient) return (sfuDevice = false);
  const res = await sfuAck('sfu-caps', {});
  if (!res || !res.ok) return (sfuDevice = false);
  try {
    const d = new mediasoupClient.Device();
    await d.load({ routerRtpCapabilities: res.rtpCapabilities });
    sfuDevice = d;
  } catch { sfuDevice = false; }
  return sfuDevice;
}

async function sfuTransport(dir) {
  const params = await sfuAck('sfu-create-transport', { dir });
  if (!params || !params.ok) return null;
  const t = dir === 'send' ? sfuDevice.createSendTransport(params) : sfuDevice.createRecvTransport(params);
  t.on('connect', ({ dtlsParameters }, cb, errb) => {
    socket.emit('sfu-connect', { dir, dtlsParameters }, (r) => (r && r.ok ? cb() : errb(new Error('sfu-connect'))));
  });
  if (dir === 'send') {
    t.on('produce', ({ kind, rtpParameters }, cb, errb) => {
      socket.emit('sfu-produce', { kind, rtpParameters }, (r) => (r && r.ok ? cb({ id: r.id }) : errb(new Error('sfu-produce'))));
    });
  }
  return t;
}

// Transmissor: publica a tela no SFU (chamado logo após o screen-share on)
async function sfuPublish() {
  try {
    if (!(await sfuInit()) || !screenStream) return;
    if (!sfuSend || sfuSend.closed) sfuSend = await sfuTransport('send');
    if (!sfuSend) return;
    const q = livePreset();
    const v = screenStream.getVideoTracks()[0];
    const a = screenStream.getAudioTracks()[0];
    sfuProducers.push(await sfuSend.produce({ track: v, encodings: [{ maxBitrate: q.bitrate }] }));
    // Áudio da live em estéreo (jogo/música) com DTX (silêncio não gasta banda)
    if (a) sfuProducers.push(await sfuSend.produce({ track: a, codecOptions: { opusStereo: true, opusDtx: true } }));
    sfuLive = true; // watch-request P2P vira no-op: o servidor é quem distribui
  } catch (err) { console.warn('[sfu] publicar falhou — P2P assume:', err); }
}

function sfuStopPublish() {
  sfuProducers.forEach((p) => { try { p.close(); } catch { /* já fechado */ } });
  sfuProducers = [];
  sfuLive = false;
}

// Espectador: consome a live de `id` do SFU. true = tile criado por aqui.
async function sfuWatch(id) {
  try {
    if (!(await sfuInit())) return false;
    if (!sfuRecv || sfuRecv.closed) sfuRecv = await sfuTransport('recv');
    if (!sfuRecv) return false;
    // Até 3 tentativas: o transmissor pode ainda estar publicando (corrida watch × produce)
    for (let i = 0; i < 3; i++) {
      const res = await sfuAck('sfu-consume', { sharer: id, rtpCapabilities: sfuDevice.rtpCapabilities });
      if (res && res.ok && res.consumers.length) {
        if (!watching.has(id)) return true; // desistiu durante a espera
        sfuUnwatch(id); // consumers antigos (re-assistir) não vazam
        const stream = new MediaStream();
        const list = [];
        for (const c of res.consumers) {
          const consumer = await sfuRecv.consume(c);
          list.push(consumer);
          stream.addTrack(consumer.track);
        }
        sfuConsumers.set(id, list);
        screenStreams.set(id, stream);
        addScreenTile(id, stream);
        return true;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  } catch (err) { console.warn('[sfu] assistir falhou — P2P assume:', err); }
  return false;
}

function sfuUnwatch(id) {
  const list = sfuConsumers.get(id);
  if (!list) return;
  list.forEach((c) => { try { c.close(); } catch { /* já fechado */ } });
  sfuConsumers.delete(id);
  screenStreams.delete(id); // stream do SFU morre com os consumers (re-assistir consome de novo)
}

// Qualidade da transmissão: quem transmite escolhe o peso no próprio PC (perfil → Transmissão).
// Fluido corta o custo do encode (resolução/fps/bitrate menores) para jogar sem travar.
const LIVE_PRESETS = {
  alta:  { w: 1920, h: 1080, fps: 60, bitrate: 8_000_000, floor: 2_500_000 }, // teto: 1080p60
  media: { w: 1280, h: 720,  fps: 30, bitrate: 4_000_000, floor: 1_500_000 },
  baixa: { w: 854,  h: 480,  fps: 30, bitrate: 1_500_000, floor: 800_000 },
};
// Modo auto: começa no topo (alta) e desce a escada sob pressão de CPU/rede, subindo de volta na folga
const AUTO_LADDER = ['alta', 'media', 'baixa'];
let autoLevel = 0;
function liveQualityMode() {
  const sel = localStorage.getItem('hx-live-quality');
  return (sel === 'auto' || LIVE_PRESETS[sel]) ? sel : 'auto';
}
function livePreset() {
  const sel = liveQualityMode();
  return sel === 'auto' ? LIVE_PRESETS[AUTO_LADDER[autoLevel]] : (LIVE_PRESETS[sel] || LIVE_PRESETS.alta);
}
function applyLivePreset() { // aplica o preset vigente na live aberta (resolução/fps no track, bitrate nos senders)
  if (!screenStream) return;
  const q = livePreset();
  screenStream.getVideoTracks()[0]
    ?.applyConstraints({ width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps, max: q.fps } })
    .catch(() => {});
  retuneSenders();
}

if (!LIVE_PRESETS[localStorage.getItem('hx-live-quality')] && localStorage.getItem('hx-live-quality') !== 'auto') {
  localStorage.removeItem('hx-live-quality'); // chave antiga/inválida
}
$('live-quality').value = localStorage.getItem('hx-live-quality') || 'auto';
$('live-quality').onchange = () => {
  localStorage.setItem('hx-live-quality', $('live-quality').value);
  autoLevel = 0; // troca de modo recomeça do topo
  applyLivePreset();
};

async function toggleScreen() {
  if (screenPending) return;
  if (screenStream) { stopScreen(true, 'botão parar do app'); return; }
  screenPending = true;
  const q = livePreset();
  let stream;
  try {
    // Seletor nativo: tela inteira, janela ou aplicativo aberto (mesmo mecanismo do Discord)
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps, max: q.fps } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, // som da aba/jogo, sem processar
      surfaceSwitching: 'include',    // trocar de janela sem parar a live
      selfBrowserSurface: 'exclude',  // evita efeito túnel capturando a própria aba
      monitorTypeSurfaces: 'include',
    });
  } catch { return; } // usuário cancelou o seletor
  finally { screenPending = false; }
  if (!inVoice || screenStream) { stream.getTracks().forEach((t) => t.stop()); return; } // saiu da voz durante o seletor
  screenStream = stream;
  // Dica ao encoder: conteúdo de movimento (jogo) — prioriza fluidez sobre nitidez de texto parado
  const vt = stream.getVideoTracks()[0];
  if (vt && 'contentHint' in vt) vt.contentHint = 'motion';
  const track = screenStream.getVideoTracks()[0];
  track.contentHint = 'motion'; // prioriza fluidez (jogos); encoder mantém frame rate
  track.onended = () => stopScreen(true, 'captura encerrada pelo navegador ou sistema'); // barra "parar compartilhamento", janela fechada
  addScreenTile(selfId, screenStream, true);
  socket.emit('screen-share', { on: true });
  sfuPublish(); // servidor assume a distribuição; se falhar, o watch-request P2P continua servindo
  updateBadge(selfId, true);
  $('screen-btn').classList.add('active');
  playSound('screenOn');
  renderNetStatus();
  thumbTimer = setInterval(sendThumb, 3000);
  setTimeout(sendThumb, 600); // primeira prévia rápida
  limitedStreak = fineStreak = 0; lastOutStats = null;
  liveStatsTimer = setInterval(pollLiveStats, 4000); // saúde + modo auto
}

function stopScreen(sound = true, reason = 'não especificado') {
  if (!screenStream) return;
  clearInterval(thumbTimer);
  thumbTimer = null;
  clearInterval(liveStatsTimer);
  liveStatsTimer = null;
  autoLevel = 0; // próxima live recomeça do topo
  sfuStopPublish();
  peers.forEach(removeScreenSenders);
  viewerSenders.clear();
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  removeScreenTile(selfId);
  socket.emit('screen-share', { on: false, reason }); // motivo vai para o log do servidor
  renderNetStatus();
  updateBadge(selfId, false);
  $('screen-btn').classList.remove('active');
  if (sound) playSound('screenOff');
}

// ---------- Saúde da live + modo auto ----------
// Transmissor: lê as stats do encoder a cada 4s. Alimenta o chip de saúde do próprio tile e,
// no modo auto, desce a qualidade sob pressão sustentada de CPU/rede (e sobe de volta na folga).
let liveStatsTimer = null;
let limitedStreak = 0, fineStreak = 0, lastOutStats = null;

async function pollLiveStats() {
  const sender = sfuLive ? sfuProducers.find((p) => p.kind === 'video') : [...viewerSenders.values()].find(Boolean);
  if (!sender || !screenStream) return;
  let report;
  try { report = await sender.getStats(); } catch { return; }
  let out = null;
  report.forEach((s) => { if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) out = s; });
  if (!out) return;
  let mbps = 0;
  if (lastOutStats && out.timestamp > lastOutStats.ts) {
    mbps = ((out.bytesSent || 0) - lastOutStats.bytes) * 8 / ((out.timestamp - lastOutStats.ts) / 1000) / 1e6;
  }
  lastOutStats = { ts: out.timestamp, bytes: out.bytesSent || 0 };
  const reason = out.qualityLimitationReason || 'none';
  const fps = Math.round(out.framesPerSecond || 0);
  const tile = document.getElementById('screen-' + selfId);
  const chip = tile?.querySelector('.health');
  if (chip) {
    const v = tile.querySelector('video');
    chip.textContent = `${v?.videoHeight || '?'}p ${fps}fps · ${mbps.toFixed(1)} Mbps`
      + (reason !== 'none' ? ` · limitado: ${reason === 'cpu' ? 'CPU' : 'rede'}` : '')
      + (liveQualityMode() === 'auto' ? ` · auto (${AUTO_LADDER[autoLevel]})` : '');
  }
  if (liveQualityMode() !== 'auto') return;
  if (reason === 'cpu' || reason === 'bandwidth') { limitedStreak++; fineStreak = 0; } else { fineStreak++; limitedStreak = 0; }
  if (limitedStreak >= 2 && autoLevel < AUTO_LADDER.length - 1) {
    autoLevel++; limitedStreak = 0; applyLivePreset(); // ~8s de aperto: desce um degrau
  } else if (fineStreak >= 8 && autoLevel > 0) {
    autoLevel--; fineStreak = 0; applyLivePreset(); // ~32s de folga: sobe de volta
  }
}

// Espectador: fps/bitrate/perda de cada live assistida (chip aparece no hover do tile)
async function pollViewerStats() {
  for (const tile of document.querySelectorAll('.screen-tile')) {
    const id = tile.id.slice('screen-'.length);
    if (id === selfId) continue;
    let report = null;
    try {
      const consumer = sfuConsumers.get(id)?.find((c) => c.kind === 'video');
      report = consumer ? await consumer.getStats() : await peers.get(id)?.pc.getStats();
    } catch { continue; }
    if (!report) continue;
    let inb = null;
    report.forEach((s) => { if (s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) inb = s; });
    if (!inb) continue;
    const prev = tile._inStats;
    let mbps = 0, lossPct = 0;
    if (prev && inb.timestamp > prev.ts) {
      mbps = ((inb.bytesReceived || 0) - prev.bytes) * 8 / ((inb.timestamp - prev.ts) / 1000) / 1e6;
      const dPkts = (inb.packetsReceived || 0) - prev.pkts;
      const dLost = Math.max(0, (inb.packetsLost || 0) - prev.lost);
      lossPct = dPkts + dLost > 0 ? (dLost / (dPkts + dLost)) * 100 : 0;
    }
    tile._inStats = { ts: inb.timestamp, bytes: inb.bytesReceived || 0, pkts: inb.packetsReceived || 0, lost: inb.packetsLost || 0 };
    const chip = tile.querySelector('.health');
    if (chip && prev) {
      const v = tile.querySelector('video');
      chip.textContent = `${v?.videoHeight || '?'}p ${Math.round(inb.framesPerSecond || 0)}fps · ${mbps.toFixed(1)} Mbps`
        + (lossPct >= 1 ? ` · perda ${lossPct.toFixed(0)}%` : '');
    }
  }
}
setInterval(pollViewerStats, 3000);

function sendThumb() {
  const video = document.getElementById('screen-' + selfId)?.querySelector('video');
  if (!video || video.readyState < 2 || !video.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = Math.round(320 * video.videoHeight / video.videoWidth) || 180;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  socket.emit('screen-thumb', { img: canvas.toDataURL('image/jpeg', 0.5) });
}

// Codec: H.264 tem encoder de hardware na maioria das GPUs (NVENC/QuickSync/AMF) —
// o encode sai da CPU do transmissor. VP9/AV1 comprimem melhor mas são encode por software (pesado).
function preferBestCodec(pc, sender) {
  try {
    const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs;
    if (!transceiver || !codecs) return;
    const rank = (c) => (/H264/i.test(c.mimeType) ? 0 : /VP9/i.test(c.mimeType) ? 1 : 2);
    transceiver.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
  } catch { /* navegador sem suporte: fica o codec padrão */ }
}

// Bitrate adaptativo: mesh = 1 encode por espectador; divide o orçamento para não travar
function retuneSenders() {
  const q = livePreset();
  const n = Math.max(1, viewerSenders.size);
  const bitrate = Math.max(q.floor, Math.floor(q.bitrate / n)); // divide entre espectadores, com piso
  const fps = n > 1 ? Math.min(30, q.fps) : q.fps; // 2+ espectadores: 30fps corta o custo de cada encode
  viewerSenders.forEach((sender) => {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) return;
    p.degradationPreference = 'maintain-framerate';
    p.encodings[0].maxBitrate = bitrate;
    p.encodings[0].maxFramerate = fps;
    sender.setParameters(p).catch(() => {});
  });
}

// Espectador pediu para assistir minha tela
socket.on('watch-request', ({ from } = {}) => {
  if (!screenStream || typeof from !== 'string') return;
  if (sfuLive) return; // o SFU distribui: nada de cópia P2P por espectador
  if (viewerSenders.has(from)) return;
  // getPeer (não peers.get): logo após reload do espectador o pc dele pode ainda não existir
  // aqui — descartaria o pedido e ele ficaria em "Parar de assistir" sem vídeo nunca chegar
  const peer = getPeer(from);
  const vTrack = screenStream.getVideoTracks()[0];
  const aTrack = screenStream.getAudioTracks()[0]; // pode não existir (usuário não marcou "compartilhar áudio")
  // addTrack SEMPRE (nada de replaceTrack): cada assistir gera renegociação nova, e o espectador
  // sempre recebe o vídeo por evento. O replaceTrack silencioso era a raiz do "travado sem vídeo":
  // se uma renegociação se perdia, nenhum assistir futuro renegociava de novo — lock permanente.
  removeScreenSenders(peer);
  peer.screenSender = peer.pc.addTrack(vTrack, screenStream);
  preferBestCodec(peer.pc, peer.screenSender);
  if (aTrack) peer.screenAudioSender = peer.pc.addTrack(aTrack, screenStream);
  viewerSenders.set(from, peer.screenSender);
  retuneSenders(); // encodings tardios: onsignalingstatechange re-aplica quando fechar
});

// Tira os senders de tela de um peer (renegocia sozinho); addTrack seguinte recomeça limpo
function removeScreenSenders(peer) {
  try { if (peer.screenSender) peer.pc.removeTrack(peer.screenSender); } catch { /* pc já fechado */ }
  try { if (peer.screenAudioSender) peer.pc.removeTrack(peer.screenAudioSender); } catch { /* pc já fechado */ }
  peer.screenSender = peer.screenAudioSender = null;
}

socket.on('watch-stop', ({ from } = {}) => {
  if (!viewerSenders.delete(from)) return;
  const peer = peers.get(from);
  if (peer) removeScreenSenders(peer);
  retuneSenders(); // sobrou banda para os que ficaram
});

// ---------- Transmissões dos outros: badge AO VIVO + prévia + assistir ----------
let previewId = null;

socket.on('screen-share', ({ id, username: name, on }) => {
  if (on) {
    sharers.set(id, { username: name, thumb: sharers.get(id)?.thumb || null });
    updateBadge(id, true);
    if (inVoice) playSound('screenOn');
  } else {
    sharerGone(id);
  }
});

socket.on('screen-thumb', ({ id, img }) => {
  const s = sharers.get(id);
  if (!s || typeof img !== 'string') return;
  s.thumb = img;
  if (previewId === id) updatePreview();
});

// Plateia da live: avatares no rodapé do tile, ao lado do nome de quem transmite
socket.on('watchers', ({ id, names } = {}) => {
  const s = sharers.get(id);
  if (s) s.watchers = Array.isArray(names) ? names : [];
  renderTileViewers(id);
});

function renderTileViewers(id) {
  const box = document.querySelector('#screen-' + CSS.escape(id) + ' .tile-viewers');
  if (!box) return;
  const names = sharers.get(id)?.watchers || [];
  box.replaceChildren(...names.map((n) => avatarEl(n, 18)));
  box.title = names.length ? 'Assistindo: ' + names.join(', ') : '';
}

function sharerGone(id) {
  if (!sharers.delete(id)) return;
  updateBadge(id, false);
  watching.delete(id);
  sfuUnwatch(id);
  // NÃO apaga screenStreams aqui: o receiver continua válido no pc. Na próxima live o transmissor
  // faz replaceTrack (sem novo ontrack) — sem o cache, o re-assistir esperaria um evento que nunca
  // vem e travava. O cache só morre com o pc (removePeer).
  removeScreenTile(id);
  if (previewId === id) hidePreview();
}

function updateBadge(id, on) {
  const li = document.getElementById('voice-user-' + id);
  if (!li) return;
  let badge = li.querySelector('.live-badge');
  if (on && !badge) {
    badge = document.createElement('span');
    badge.className = 'live-badge';
    badge.textContent = 'AO VIVO';
    badge.title = 'Prévia da transmissão';
    // Prévia em hover (não modal): passar o mouse mostra o popup; sair esconde com folga
    badge.onmouseenter = () => showPreview(id, badge);
    badge.onmouseleave = schedulePreviewHide;
    badge.onclick = (e) => e.stopPropagation(); // não abrir o perfil ao clicar no badge
    li.appendChild(badge);
  } else if (!on && badge) {
    badge.remove();
  }
}

// ---------- Prévia em hover no badge AO VIVO ----------
let previewHideTimer = null;

function showPreview(id, badge) {
  if (id === selfId) return; // sua própria tela já aparece no painel
  clearTimeout(previewHideTimer);
  previewId = id;
  const pop = $('live-preview');
  // Ancora ao lado do badge, dentro da tela
  const r = badge.getBoundingClientRect();
  pop.style.left = Math.min(r.right + 8, window.innerWidth - 320) + 'px';
  pop.style.top = Math.min(r.top, window.innerHeight - 240) + 'px';
  updatePreview();
  // Sem animação de entrada: showPreview re-dispara a cada hover no badge e tweens
  // sobrepostos faziam o popup piscar/sumir debaixo do mouse (é interativo — tem o Assistir)
  pop.classList.remove('hidden');
}

function schedulePreviewHide() {
  clearTimeout(previewHideTimer);
  previewHideTimer = setTimeout(hidePreview, 350); // folga para levar o mouse até o popup
}

function hidePreview() {
  previewId = null;
  $('live-preview').classList.add('hidden');
}

// Manter aberto enquanto o mouse está no popup (para clicar em Assistir)
$('live-preview').onmouseenter = () => clearTimeout(previewHideTimer);
$('live-preview').onmouseleave = schedulePreviewHide;

function updatePreview() {
  const s = sharers.get(previewId);
  if (!s) { hidePreview(); return; }
  $('preview-title').textContent = s.username + ' está transmitindo';
  if (s.thumb) {
    $('preview-img').src = s.thumb;
    $('preview-img').classList.remove('hidden');
    $('preview-empty').classList.add('hidden');
  } else {
    $('preview-img').classList.add('hidden');
    $('preview-empty').classList.remove('hidden');
  }
  const btn = $('preview-watch');
  if (!inVoice) {
    btn.disabled = true;
    btn.textContent = 'Entre na voz para assistir';
    btn.className = '';
  } else if (watching.has(previewId)) {
    btn.disabled = false;
    btn.textContent = 'Parar de assistir';
    btn.className = 'watching';
  } else {
    btn.disabled = false;
    btn.textContent = 'Assistir';
    btn.className = '';
  }
}

$('preview-watch').onclick = () => {
  if (!previewId || !inVoice) return;
  toggleWatch(previewId);
  updatePreview(); // reflete Assistir/Parar sem fechar o popup
};

// ---------- Editar perfil (foto) ----------
function renderProfileAvatar() {
  const overlay = document.createElement('div');
  overlay.className = 'avatar-overlay';
  overlay.innerHTML = '<svg class="icon"><use href="#i-image"/></svg>';
  $('profile-avatar-holder').replaceChildren(avatarEl(username, 80), overlay);
}

$('user-footer').onclick = () => {
  renderProfileAvatar();
  $('profile-display-name').textContent = username;
  $('rename-input').value = username;
  $('noise-toggle').checked = noiseSuppression;
  syncInputUi(); // PTT + VAD (toggles, tecla, limiar)
  $('profile-error').textContent = '';
  $('profile-ok').textContent = '';
  $('profile-overlay').classList.remove('hidden');
  fxModal($('profile-overlay'));
  startVadMeter(); // medidor ao vivo do microfone enquanto o perfil está aberto
};

// Medidor ao vivo do mic no perfil (barra verde) — sincronizado com o mesmo nível do contorno de fala
let vadMeterTimer = null;
function startVadMeter() {
  clearInterval(vadMeterTimer);
  const fill = $('vad-fill');
  vadMeterTimer = setInterval(() => {
    if ($('profile-overlay').classList.contains('hidden')) { clearInterval(vadMeterTimer); vadMeterTimer = null; return; }
    const lvl = meters.get(selfId)?.level ?? 0; // nível do clone do mic (mesmo do contorno verde)
    fill.style.width = Math.min(100, (lvl / VAD_MAX_RMS) * 100) + '%';
    // acende verde quando passa do limiar (bate com o gate/contorno)
    fill.classList.toggle('over', lvl >= vadOnLevel());
  }, 100);
}

$('noise-toggle').onchange = applyMicSettings;

$('avatar-remove').onclick = () => {
  socket.emit('set-avatar', { img: null }, (res) => {
    if (!res || res.error) { $('profile-error').textContent = (res && res.error) || 'Falha ao remover.'; return; }
    avatares.delete(username);
    refreshAvatars(username);
    renderProfileAvatar();
  });
};

function applyRename(id, oldName, newName) {
  const photo = avatares.get(oldName);
  if (photo) { avatares.set(newName, photo); avatares.delete(oldName); }
  allNames.delete(oldName);
  allNames.add(newName);
  if (onlineNames.delete(oldName)) onlineNames.add(newName);
  renderOffline();
  clearTyping(oldName); // evita "oldName e newName estão digitando" da mesma pessoa
  const userLi = document.getElementById('user-' + id);
  if (userLi) {
    const span = document.createElement('span');
    span.textContent = newName;
    userLi.replaceChildren(avatarEl(newName, 26), span);
  }
  const voiceLi = document.getElementById('voice-user-' + id);
  if (voiceLi) {
    voiceLi.querySelector('.name').textContent = newName;
    voiceLi.querySelector('.avatar').replaceWith(avatarEl(newName, 24));
  }
  const savedVol = localStorage.getItem('hx-vol-' + oldName);
  if (savedVol !== null) {
    localStorage.setItem('hx-vol-' + newName, savedVol); // ajuste de volume sobrevive ao rename
    localStorage.removeItem('hx-vol-' + oldName);
  }
  const sharer = sharers.get(id);
  if (sharer) sharer.username = newName;
}

socket.on('user-renamed', ({ id, oldName, newName } = {}) => {
  if (typeof id !== 'string' || typeof newName !== 'string') return;
  applyRename(id, oldName, newName);
});

$('rename-save').onclick = () => {
  const name = $('rename-input').value.trim();
  if (!name || name === username) return;
  socket.emit('rename', { username: name }, (res) => {
    if (!res || res.error) { $('profile-error').textContent = (res && res.error) || 'Falha ao trocar o nome.'; return; }
    const oldName = username;
    username = res.username;
    applyRename(selfId, oldName, username);
    $('self-name').textContent = username;
    $('self-avatar').replaceChildren(avatarEl(username, 28));
    renderProfileAvatar();
    $('profile-display-name').textContent = username; // cabeçalho do modal aberto acompanha
    $('rename-input').value = username;               // nome canônico do servidor ("ANA" -> "ana")
    $('profile-error').textContent = '';
  });
};
$('profile-close').onclick = () => $('profile-overlay').classList.add('hidden');
$('profile-overlay').onclick = (e) => { if (e.target === $('profile-overlay')) $('profile-overlay').classList.add('hidden'); };
$('avatar-pick').onclick = () => $('avatar-file').click();
$('profile-avatar-holder').onclick = () => $('avatar-file').click();

$('avatar-file').onchange = async () => {
  const file = $('avatar-file').files[0];
  $('avatar-file').value = '';
  if (!file) return;
  let img;
  try {
    // Recorte quadrado 256px: nítido mesmo em telas de alta densidade.
    // Retrato: rosto costuma ficar no terço superior — recorte puxado para cima, não o centro.
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height);
    const sx = (bmp.width - side) / 2;
    const sy = bmp.height > bmp.width ? (bmp.height - side) * 0.2 : (bmp.height - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, sx, sy, side, side, 0, 0, 256, 256);
    img = canvas.toDataURL('image/jpeg', 0.92);
    if (img.length > 100 * 1024) img = canvas.toDataURL('image/jpeg', 0.8); // garante o limite do servidor
  } catch {
    $('profile-error').textContent = 'Não consegui ler essa imagem.';
    return;
  }
  socket.emit('set-avatar', { img }, (res) => {
    if (!res || res.error) {
      $('profile-error').textContent = (res && res.error) || 'Falha ao salvar a foto.';
      return;
    }
    avatares.set(username, img);
    refreshAvatars(username);
    renderProfileAvatar();
  });
};

// ---------- Perfil de um membro (clique no participante da call) ----------
let userCardFor = null; // evita resposta atrasada sobrescrever outro perfil aberto

function openUserProfile(id, name) {
  userCardFor = name;
  $('user-card-avatar').replaceChildren(avatarEl(name, 80));
  $('user-card-name').textContent = name;
  $('user-card-since').textContent = 'Servidor HX';
  socket.emit('get-profile', { username: name }, (res) => {
    if (userCardFor !== name) return;
    if (res && res.ok && res.created) {
      $('user-card-since').textContent = 'Membro desde ' +
        new Date(res.created).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
    }
  });
  const isOther = id !== selfId;
  $('user-volume-section').classList.toggle('hidden', !isOther);
  if (isOther) {
    const vol = $('user-volume');
    vol.value = localStorage.getItem('hx-vol-' + name) ?? 100;
    vol.oninput = () => {
      const a = document.getElementById('audio-' + id);
      if (a) a.volume = vol.value / 100;
      // Lê o nome atual do DOM: se a pessoa renomear com o modal aberto, salva na chave certa
      localStorage.setItem('hx-vol-' + voiceUserName(id), vol.value);
    };
  }
  $('user-overlay').classList.remove('hidden');
  fxModal($('user-overlay'));
}

function closeUserProfile() {
  userCardFor = null;
  $('user-overlay').classList.add('hidden');
}

$('user-close').onclick = closeUserProfile;
$('user-overlay').onclick = (e) => { if (e.target === $('user-overlay')) closeUserProfile(); };

function toggleWatch(id) {
  if (!inVoice) { systemMessage('Entre no canal de voz para assistir.'); return; }
  if (watching.has(id)) {
    socket.emit('unwatch', { to: id });
    watching.delete(id);
    sfuUnwatch(id); // consumers do SFU fecham; no P2P o stream fica em cache para reabrir
    removeScreenTile(id);
  } else {
    watching.add(id);
    // Sair do modo chat para ver a live que abri
    document.querySelector('.content').classList.remove('chat-open');
    socket.emit('watch', { to: id }, (res) => {
      if (!res || !res.ok) { // transmissão acabou de encerrar
        watching.delete(id);
        removeScreenTile(id);
        systemMessage('Essa transmissão já encerrou.');
        if (previewId) updatePreview();
        return;
      }
      // Preferência: consumir do SFU (1 upload no transmissor). Falhou? P2P de sempre:
      // re-assistir usa o cache; primeira vez o tile nasce no ontrack.
      sfuWatch(id).then((viaSfu) => {
        if (viaSfu) return;
        const cached = screenStreams.get(id);
        if (cached && !document.getElementById('screen-' + id)) addScreenTile(id, cached);
      });
      // Cinto: vídeo não apareceu em 5s = renegociação perdida — desarma o estado (nada de lock
      // eterno em "Parar de assistir") e avisa para tentar de novo
      setTimeout(() => {
        if (!watching.has(id) || document.getElementById('screen-' + id)) return;
        watching.delete(id);
        socket.emit('unwatch', { to: id });
        systemMessage('A live de ' + (sharers.get(id)?.username || 'usuário') + ' não respondeu — tente assistir de novo.');
        if (previewId) updatePreview();
      }, 5000);
    });
  }
  if (previewId) updatePreview();
}

// ---------- Tiles de vídeo (zoom com scroll, expandir, tela cheia) ----------
function tileButton(iconId, title, onClick) {
  const b = document.createElement('button');
  b.title = title;
  b.innerHTML = '<svg class="icon"><use href="#i-' + iconId + '"/></svg>';
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

let draggingTile = null; // tile em arrasto no grid de lives

// Nível de zoom do feed: 1 = live centralizada, 2 = grid 2x2, 3 = grid 3x3
let gridLevel = 1;
function setGridLevel(n, focusTile) {
  gridLevel = Math.min(3, Math.max(1, n));
  const s = $('screens');
  s.classList.toggle('grid-2', gridLevel === 2);
  s.classList.toggle('grid-3', gridLevel === 3);
  // Fechou até a vista centralizada: a live sob o cursor assume a tela
  if (gridLevel === 1 && focusTile) focusTile.scrollIntoView({ block: 'center' });
}

function updateLiveMode() {
  const live = $('screens').children.length > 0;
  $('screens').classList.toggle('hidden', !live);
  const content = document.querySelector('.content');
  content.classList.toggle('live-mode', live);
  if (!live) content.classList.remove('chat-open'); // sem lives, o chat volta a ser o padrão
}

// Alternância chat ⇄ lives: clicar em #geral minimiza as lives; a tag vermelha volta pra elas
$('text-geral').onclick = () => {
  if (document.querySelector('.content').classList.contains('live-mode')) {
    document.querySelector('.content').classList.add('chat-open');
    $('chat-input').focus();
  }
};
$('back-to-live').onclick = () => document.querySelector('.content').classList.remove('chat-open');

function addScreenTile(id, stream, muted = false) {
  removeScreenTile(id);
  const tile = document.createElement('div');
  tile.className = 'screen-tile';
  tile.id = 'screen-' + id;

  const isSelf = id === selfId;
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  // Própria tela sempre muda (evita eco); live de outro toca, mas fica muda se estou silenciado
  video.muted = muted || (!isSelf && deafened);
  video.srcObject = stream;

  const label = document.createElement('div');
  label.className = 'label';
  const labelName = document.createElement('span');
  labelName.textContent = isSelf ? 'Sua tela' : voiceUserName(id);
  const viewersBox = document.createElement('div');
  viewersBox.className = 'tile-viewers';
  label.append(labelName, viewersBox);

  const controls = document.createElement('div');
  controls.className = 'controls';

  // Volume da live (áudio compartilhado) — só nas telas de outros; ícones ao lado do maximizar
  if (!isSelf) {
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0;
    slider.max = 100;
    slider.value = 100;
    slider.className = 'tile-vol';
    slider.title = 'Volume da live';
    // Fonte da verdade: mudo manual (botão do tile) OU silenciado geral (headset).
    // Centralizado para o ícone/slider nunca dessincronizarem do estado real do áudio.
    let userMuted = muted;
    let volBtn; // atribuído logo abaixo; applyMute só roda depois
    const applyMute = () => {
      video.muted = userMuted || deafened;
      volBtn.querySelector('use').setAttribute('href', video.muted ? '#i-volume-x' : '#i-volume');
      slider.disabled = video.muted;
      if (!video.muted) video.play().catch(() => {});
    };
    // Ligar o som do tile estando silenciado = quero ouvir: sai do deafen (como o mic faz ao falar).
    // toggleDeafen re-sincroniza todos os tiles (inclusive este) e o ícone do headset na lista.
    volBtn = tileButton('volume', 'Mudo / Som da live', () => {
      userMuted = !userMuted;
      if (!userMuted && deafened) { toggleDeafen(); return; }
      applyMute();
    });
    slider.oninput = () => {
      video.volume = slider.value / 100;
      if (video.volume > 0) userMuted = false;
      if (deafened) { toggleDeafen(); return; }
      applyMute();
    };
    applyMute();                 // reflete o estado inicial (mudo se silenciado)
    video._applyMute = applyMute; // toggleDeafen re-sincroniza cada tile por aqui
    controls.append(volBtn, slider);

    // Maximizar: só live dos outros — a própria não tem por quê (é a sua tela ao vivo)
    controls.append(tileButton('fullscreen', 'Tela cheia', () => video.requestFullscreen?.().catch(() => {})));
    video.ondblclick = () => video.requestFullscreen?.().catch(() => {});
  } else {
    // Transmissor: minimiza a própria live (vira faixa fina) pra assistir às lives dos outros
    const minBtn = tileButton('minus', 'Minimizar sua live', () => {
      const mini = tile.classList.toggle('mini');
      minBtn.querySelector('use').setAttribute('href', mini ? '#i-fullscreen' : '#i-minus');
      minBtn.title = mini ? 'Expandir sua live' : 'Minimizar sua live';
    });
    controls.append(minBtn);
  }

  const health = document.createElement('div');
  health.className = 'health';
  health.title = 'Saúde da transmissão';
  tile.append(video, label, controls, health);

  // Grid customizável: arrastar reordena as lives; roda do mouse sobre o tile redimensiona
  tile.draggable = true;
  tile.ondragstart = (e) => {
    if (e.target.closest('button, input')) { e.preventDefault(); return; } // slider/botões não arrastam o tile
    draggingTile = tile;
    tile.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  };
  tile.ondragend = () => { tile.classList.remove('dragging'); draggingTile = null; };
  tile.ondragover = (e) => {
    if (!draggingTile || draggingTile === tile) return;
    e.preventDefault();
    const r = tile.getBoundingClientRect();
    tile.parentNode.insertBefore(draggingTile, e.clientY < r.top + r.height / 2 ? tile : tile.nextSibling);
  };
  tile.onwheel = (e) => {
    if (e.ctrlKey) return; // zoom do navegador continua funcionando
    e.preventDefault();
    // Zoom em degraus: para trás abre o grid (2x2 → 3x3); para frente fecha até centralizar esta live
    setGridLevel(gridLevel + (e.deltaY > 0 ? 1 : -1), tile);
  };
  // A própria live fica sempre no FIM do feed: live nova dos outros entra acima dela,
  // visível de cara (antes nascia "lá embaixo", escondida atrás da sua)
  const own = document.getElementById('screen-' + selfId);
  if (!isSelf && own) $('screens').insertBefore(tile, own);
  else $('screens').appendChild(tile);
  renderTileViewers(id); // plateia atual (snapshot ou eventos anteriores)
  // Sem animação de entrada: transform em filho de container com scroll-snap re-snapava o feed
  updateLiveMode();
  // Cada tile ocupa 100% da altura: a live nova nasceria fora da vista
  tile.scrollIntoView({ block: 'center' });
}

function removeScreenTile(id) {
  // Remoção seca: fade de saída segurava o tile 150ms no feed e o scroll-snap re-snapava ao topo
  document.getElementById('screen-' + id)?.remove();
  updateLiveMode();
}
