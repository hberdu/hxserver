/* HX Chat — cliente: login, chat via Socket.IO, voz e tela via WebRTC mesh */
const socket = io();
const $ = (id) => document.getElementById(id);

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
  el.textContent = text;
  el.classList.remove('hidden');
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
});
$('install-btn').onclick = async () => {
  if (!installPrompt) return;
  const p = installPrompt;
  installPrompt = null; // anula antes do await: duplo clique não chama prompt() duas vezes
  $('install-btn').classList.add('hidden');
  p.prompt();
  await p.userChoice.catch(() => {});
};

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
    if (sessionStorage.getItem('hx-in-voice') === '1') joinVoice(); // estava em call antes da queda
  });
});

function enterApp(res) {
  selfId = res.selfId;
  username = res.username;
  if (res.token) localStorage.setItem('hx-token', res.token);
  avatares.clear();
  lastAuthor = null;
  $('messages').replaceChildren();
  $('user-list').replaceChildren();
  $('voice-users').replaceChildren();
  sharers.clear();
  Object.entries(res.avatars || {}).forEach(([n, img]) => avatares.set(n, img));
  $('login-screen').classList.add('hidden');
  $('main-screen').classList.remove('hidden');
  $('self-name').textContent = username;
  $('self-avatar').replaceChildren(avatarEl(username, 28));
  res.messages.forEach(renderMessage);
  allNames.clear();
  onlineNames.clear();
  (res.allUsers || []).forEach((n) => allNames.add(n));
  res.users.forEach((user) => addUser(user.id, user.username));
  renderOffline();
  res.voiceUsers.forEach((user) => addVoiceUser(user.id, user.username, user.muted, user.deafened));
  res.sharers.forEach((s) => {
    sharers.set(s.id, { username: s.username, thumb: s.thumb });
    updateBadge(s.id, true);
  });
  scrollMessages();
  $('chat-input').focus();
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
};

// Agrupamento: mensagens seguidas do mesmo autor em <5min não repetem avatar/nome
let lastAuthor = null;
let lastTs = 0;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentionsMe(text) {
  // Boundary dos dois lados: "admin@ana.com" não é menção a @ana
  return !!username && new RegExp('(?<![\\w])@' + escapeRegex(username) + '(?![\\w])', 'i').test(text);
}

// Links clicáveis: só createElement/append, nunca innerHTML (sem risco de XSS)
function fillText(textDiv, text) {
  textDiv.replaceChildren();
  text.split(/(https?:\/\/[^\s]+)/g).forEach((part, i) => {
    if (i % 2) {
      const a = document.createElement('a');
      a.href = part;
      a.textContent = part;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      textDiv.appendChild(a);
    } else if (part) {
      textDiv.append(part);
    }
  });
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
  const original = textDiv.textContent;
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
  renderOffline();
  systemMessage(name + ' entrou no servidor');
});

socket.on('user-left', ({ id, username: name }) => {
  document.getElementById('user-' + id)?.remove();
  removeVoiceUser(id);
  removePeer(id);
  sharerGone(id);
  onlineNames.delete(name);
  clearTyping(name); // "está digitando…" de quem saiu não fica pendurado
  renderOffline();
  // Libera a foto da memória se não está mais em nenhum avatar renderizado
  if (name && !document.querySelector('.avatar[data-name="' + CSS.escape(name) + '"]')) avatares.delete(name);
  systemMessage(name + ' saiu do servidor');
});

// ---------- Canal de voz (UI) ----------
let inVoice = false;
let localStream = null;   // microfone
let screenStream = null;  // tela
const peers = new Map();         // peerId -> { pc, makingOffer, ignoreOffer, polite }
const sharers = new Map();       // sharerId -> { username, thumb }
const watching = new Set();      // sharerIds que estou assistindo
const viewerSenders = new Map(); // viewerId -> RTCRtpSender do meu vídeo de tela

function addVoiceUser(id, name, muted = false, deafened = false) {
  if (document.getElementById('voice-user-' + id)) return;
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
  if (id !== selfId) {
    // Volume individual (aparece no hover): lembrado por nome entre calls
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = 0;
    vol.max = 100;
    vol.className = 'vol-slider';
    vol.value = localStorage.getItem('hx-vol-' + name) ?? 100;
    vol.title = 'Volume de ' + name;
    vol.oninput = () => {
      const a = document.getElementById('audio-' + id);
      if (a) a.volume = vol.value / 100;
      localStorage.setItem('hx-vol-' + name, vol.value);
    };
    li.appendChild(vol);
  }
  li.classList.toggle('muted', muted);
  li.classList.toggle('deafened', deafened);
  $('voice-users').appendChild(li);
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
  document.getElementById('voice-user-' + id)?.remove();
  removeScreenTile(id);
}

function voiceUserName(id) {
  return document.querySelector('#voice-user-' + CSS.escape(id) + ' .name')?.textContent
    || sharers.get(id)?.username || 'Tela';
}

$('voice-channel').onclick = joinVoice;
$('leave-voice-btn').onclick = leaveVoice;
$('mute-btn').onclick = toggleMute;
$('deafen-btn').onclick = toggleDeafen;
$('screen-btn').onclick = toggleScreen;

// ---------- Push-to-talk (segurar a tecla para falar; só com a aba focada — limite do navegador)
let pttOn = localStorage.getItem('hx-ptt') === 'on';
let pttKey = localStorage.getItem('hx-ptt-key') || 'Backquote';

$('ptt-toggle').onchange = () => {
  pttOn = $('ptt-toggle').checked;
  localStorage.setItem('hx-ptt', pttOn ? 'on' : 'off');
  $('ptt-key-row').classList.toggle('hidden', !pttOn);
  if (inVoice && !deafened) setMuted(pttOn, false); // ligou: mic fecha e espera a tecla
};

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
    closePreview();
  } else if (e.ctrlKey && e.shiftKey && e.code === 'KeyM') {
    e.preventDefault();
    toggleMute();
  } else if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
    e.preventDefault();
    toggleDeafen();
  } else if (pttOn && inVoice && !deafened && e.code === pttKey && !e.repeat && !isTypingTarget(e.target)) {
    setMuted(false, false); // tecla pressionada: fala
  }
});

document.addEventListener('keyup', (e) => {
  if (pttOn && inVoice && !deafened && e.code === pttKey && !isTypingTarget(e.target)) setMuted(true, false);
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

async function joinVoice() {
  if (inVoice) return;
  inVoice = true; // antes do await: bloqueia duplo clique durante o prompt do microfone
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
  } catch (err) {
    inVoice = false;
    systemMessage('Sem acesso ao microfone: ' + err.message);
    return;
  }
  socket.emit('join-voice', (res) => {
    if (!res || res.error) {
      inVoice = false;
      localStream?.getTracks().forEach((t) => t.stop());
      localStream = null;
      systemMessage((res && res.error) || 'Falha ao entrar no canal de voz.');
      return;
    }
    $('voice-controls').classList.remove('hidden');
    addVoiceUser(selfId, username);
    if (pttOn) setMuted(true, false); // push-to-talk: entra mutado esperando a tecla
    attachSpeaking(selfId, localStream);
    playSound('userJoin'); // toca também para quem entrou, não só para quem já estava
    sessionStorage.setItem('hx-in-voice', '1'); // volta pra call sozinho se cair
    // Novato inicia a conexão com cada participante já presente
    res.peers.forEach(({ id }) => getPeer(id));
    if (previewId) updatePreview();
  });
}

function leaveVoice() {
  if (!inVoice) return;
  inVoice = false;
  sessionStorage.removeItem('hx-in-voice');
  socket.emit('leave-voice');
  if (screenStream) stopScreen(false);
  watching.forEach((id) => removeScreenTile(id));
  watching.clear();
  viewerSenders.clear();
  [...meters.keys()].forEach(detachSpeaking);
  peers.forEach((_, id) => removePeer(id));
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  $('voice-controls').classList.add('hidden');
  removeVoiceUser(selfId);
  $('mute-btn').classList.remove('active');
  $('mute-btn').setAttribute('aria-pressed', false);
  $('mute-icon').setAttribute('href', '#i-mic');
  deafened = false;
  $('deafen-btn').classList.remove('active');
  $('deafen-btn').setAttribute('aria-pressed', false);
  $('deafen-icon').setAttribute('href', '#i-headset');
  playSound('leave');
  if (previewId) updatePreview();
}

let deafened = false;
let mutedBeforeDeafen = false; // mute explícito anterior ao deafen: preservado ao sair (como no Discord)

function setMuted(muted, sound = true) {
  const track = localStream?.getAudioTracks()[0];
  if (!track || track.enabled !== muted) return; // já está no estado pedido
  track.enabled = !muted;
  $('mute-btn').classList.toggle('active', muted);
  $('mute-btn').setAttribute('aria-pressed', muted);
  $('mute-icon').setAttribute('href', muted ? '#i-mic-off' : '#i-mic');
  setVoiceMuted(selfId, muted);
  socket.emit('set-muted', { muted });
  if (sound) playSound(muted ? 'mute' : 'unmute');
}

function toggleMute() {
  if (!localStream) return;
  // Clicar no mic estando silenciado = quero falar: sai do deafen com o mic aberto
  if (deafened) { mutedBeforeDeafen = false; toggleDeafen(); return; }
  setMuted(localStream.getAudioTracks()[0].enabled);
}

// Silenciar o canal: para de ouvir todo mundo e também fecha o próprio microfone
function toggleDeafen() {
  if (!inVoice) return;
  deafened = !deafened;
  if (deafened) mutedBeforeDeafen = !(localStream?.getAudioTracks()[0]?.enabled ?? true);
  document.querySelectorAll('audio[id^="audio-"]').forEach((a) => { a.muted = deafened; });
  $('deafen-btn').classList.toggle('active', deafened);
  $('deafen-btn').setAttribute('aria-pressed', deafened);
  $('deafen-icon').setAttribute('href', deafened ? '#i-headset-off' : '#i-headset');
  setVoiceDeafened(selfId, deafened);
  socket.emit('set-deafened', { deafened }); // setMuted não emite se o mic já estava fechado
  setMuted(deafened ? true : mutedBeforeDeafen, false); // sair do deafen devolve o estado anterior do mic
  playSound(deafened ? 'mute' : 'unmute');
}

socket.on('voice-user-joined', ({ id, username: name }) => {
  addVoiceUser(id, name);
  systemMessage(name + ' entrou no canal de voz');
  if (inVoice) playSound('userJoin'); // alerta de entrada, como no Discord
  // Conexão criada sob demanda quando a oferta do novato chegar
});

socket.on('voice-user-left', ({ id }) => {
  removeVoiceUser(id);
  removePeer(id);
  sharerGone(id);
  if (inVoice) playSound('userLeave');
});

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

function pollSpeaking() {
  const now = performance.now();
  meters.forEach((m, id) => {
    m.analyser.getByteTimeDomainData(m.data);
    let sum = 0;
    for (const v of m.data) { const d = v - 128; sum += d * d; }
    const level = Math.sqrt(sum / m.data.length);

    if (level > SPEAK_ON) m.lastLoud = now;
    const speaking = m.speaking
      ? (level > SPEAK_OFF || now - (m.lastLoud || 0) < SPEAK_HOLD_MS)
      : level > SPEAK_ON;

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
    screenSender: null,         // sender de tela reutilizado via replaceTrack (m-lines não crescem)
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

  pc.ontrack = ({ track }) => {
    if (track.kind === 'audio') {
      const stream = new MediaStream([track]);
      const audio = new Audio();
      audio.srcObject = stream;
      audio.autoplay = true;
      audio.muted = deafened; // quem chega durante o modo silenciado também fica mudo
      audio.volume = (localStorage.getItem('hx-vol-' + voiceUserName(peerId)) ?? 100) / 100;
      audio.id = 'audio-' + peerId;
      document.body.appendChild(audio);
      attachSpeaking(peerId, stream);
    } else {
      if (!watching.has(peerId)) return; // unwatch venceu a corrida com a renegociação
      addScreenTile(peerId, new MediaStream([track]));
      track.onended = () => removeScreenTile(peerId);
      // sem onmute: mute é transitório (janela minimizada, rede) — fim real chega via evento 'screen-share'
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') state.restarts = 0;
    else if (pc.connectionState === 'failed') {
      if (++state.restarts <= 3) pc.restartIce(); // re-oferta flui pela negociação perfeita
      else systemMessage('Não foi possível conectar com ' + voiceUserName(peerId) + ' (rede restritiva).');
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
  peers.delete(peerId);
  if (viewerSenders.delete(peerId)) retuneSenders(); // espectador caiu: redistribui banda
  watching.delete(peerId);
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

async function toggleScreen() {
  if (screenPending) return;
  if (screenStream) { stopScreen(); return; }
  screenPending = true;
  let stream;
  try {
    // Seletor nativo: tela inteira, janela ou aplicativo aberto (mesmo mecanismo do Discord)
    // 1080p60: nítido e fluido sem afogar encoder/rede (4K travava; WebRTC ainda adapta se faltar banda)
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } },
      surfaceSwitching: 'include',    // trocar de janela sem parar a live
      selfBrowserSurface: 'exclude',  // evita efeito túnel capturando a própria aba
      monitorTypeSurfaces: 'include',
    });
  } catch { return; } // usuário cancelou o seletor
  finally { screenPending = false; }
  if (!inVoice || screenStream) { stream.getTracks().forEach((t) => t.stop()); return; } // saiu da voz durante o seletor
  screenStream = stream;
  const track = screenStream.getVideoTracks()[0];
  track.contentHint = 'motion'; // prioriza fluidez (jogos); encoder mantém frame rate
  track.onended = () => stopScreen(); // botão "parar compartilhamento" do navegador
  addScreenTile(selfId, screenStream, true);
  socket.emit('screen-share', { on: true });
  updateBadge(selfId, true);
  $('screen-btn').classList.add('active');
  playSound('screenOn');
  thumbTimer = setInterval(sendThumb, 3000);
  setTimeout(sendThumb, 600); // primeira prévia rápida
}

function stopScreen(sound = true) {
  if (!screenStream) return;
  clearInterval(thumbTimer);
  thumbTimer = null;
  viewerSenders.forEach((sender) => sender.replaceTrack(null).catch(() => {}));
  viewerSenders.clear();
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  removeScreenTile(selfId);
  socket.emit('screen-share', { on: false });
  updateBadge(selfId, false);
  $('screen-btn').classList.remove('active');
  if (sound) playSound('screenOff');
}

function sendThumb() {
  const video = document.getElementById('screen-' + selfId)?.querySelector('video');
  if (!video || video.readyState < 2 || !video.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = Math.round(320 * video.videoHeight / video.videoWidth) || 180;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  socket.emit('screen-thumb', { img: canvas.toDataURL('image/jpeg', 0.5) });
}

// Codec: VP9 comprime ~30-40% melhor que o VP8 padrão — mais qualidade no mesmo bitrate
function preferBestCodec(pc, sender) {
  try {
    const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs;
    if (!transceiver || !codecs) return;
    const rank = (c) => (/VP9/i.test(c.mimeType) ? 0 : /AV1/i.test(c.mimeType) ? 1 : 2);
    transceiver.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
  } catch { /* navegador sem suporte: fica o codec padrão */ }
}

// Bitrate adaptativo: mesh = 1 encode por espectador; divide o orçamento para não travar
function retuneSenders() {
  const n = Math.max(1, viewerSenders.size);
  const bitrate = Math.max(2_500_000, Math.floor(8_000_000 / n)); // 8 Mbps sozinho, piso de 2.5
  viewerSenders.forEach((sender) => {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) return;
    p.degradationPreference = 'maintain-framerate';
    p.encodings[0].maxBitrate = bitrate;
    sender.setParameters(p).catch(() => {});
  });
}

// Espectador pediu para assistir minha tela
socket.on('watch-request', ({ from } = {}) => {
  if (!screenStream || typeof from !== 'string') return;
  if (viewerSenders.has(from)) return;
  // getPeer (não peers.get): logo após reload do espectador o pc dele pode ainda não existir
  // aqui — descartaria o pedido e ele ficaria em "Parar de assistir" sem vídeo nunca chegar
  const peer = getPeer(from);
  const track = screenStream.getVideoTracks()[0];
  if (peer.screenSender) {
    // Reuso do sender: replaceTrack não renegocia nem cria m-line nova (SDP não cresce)
    peer.screenSender.replaceTrack(track).catch(() => {});
  } else {
    peer.screenSender = peer.pc.addTrack(track, screenStream);
    preferBestCodec(peer.pc, peer.screenSender);
  }
  viewerSenders.set(from, peer.screenSender);
  retuneSenders(); // encodings tardios: onsignalingstatechange re-aplica quando fechar
});

socket.on('watch-stop', ({ from } = {}) => {
  const sender = viewerSenders.get(from);
  if (!sender) return;
  viewerSenders.delete(from);
  sender.replaceTrack(null).catch(() => {}); // corta o vídeo sem renegociação
  retuneSenders(); // sobrou banda para os que ficaram
});

// ---------- Transmissões dos outros: badge AO VIVO + prévia + assistir ----------
let previewId = null;

socket.on('screen-share', ({ id, username: name, on }) => {
  if (on) {
    sharers.set(id, { username: name, thumb: sharers.get(id)?.thumb || null });
    updateBadge(id, true);
    systemMessage(name + ' está transmitindo a tela');
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

function sharerGone(id) {
  if (!sharers.delete(id)) return;
  updateBadge(id, false);
  watching.delete(id);
  removeScreenTile(id);
  if (previewId === id) closePreview();
}

function updateBadge(id, on) {
  const li = document.getElementById('voice-user-' + id);
  if (!li) return;
  let badge = li.querySelector('.live-badge');
  if (on && !badge) {
    badge = document.createElement('span');
    badge.className = 'live-badge';
    badge.textContent = 'AO VIVO';
    badge.title = 'Ver prévia da transmissão';
    badge.onclick = () => openPreview(id);
    li.appendChild(badge);
  } else if (!on && badge) {
    badge.remove();
  }
}

function openPreview(id) {
  if (id === selfId) return; // sua própria tela já aparece no painel (badge é só indicador)
  previewId = id;
  updatePreview();
  $('preview-overlay').classList.remove('hidden');
}

function closePreview() {
  previewId = null;
  $('preview-overlay').classList.add('hidden');
}

$('preview-close').onclick = closePreview;
$('preview-overlay').onclick = (e) => { if (e.target === $('preview-overlay')) closePreview(); };

function updatePreview() {
  const s = sharers.get(previewId);
  if (!s) { closePreview(); return; }
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
    btn.textContent = 'Entre no canal de voz para assistir';
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
  const started = !watching.has(previewId);
  toggleWatch(previewId);
  if (started) closePreview();
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
  $('ptt-toggle').checked = pttOn;
  $('ptt-key').value = pttKey;
  $('ptt-key-row').classList.toggle('hidden', !pttOn);
  $('profile-error').textContent = '';
  $('profile-ok').textContent = '';
  $('profile-overlay').classList.remove('hidden');
};

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
    const vol = voiceLi.querySelector('.vol-slider');
    if (vol) {
      vol.title = 'Volume de ' + newName;
      const saved = localStorage.getItem('hx-vol-' + oldName);
      if (saved !== null) {
        localStorage.setItem('hx-vol-' + newName, saved); // ajuste sobrevive ao rename
        localStorage.removeItem('hx-vol-' + oldName);
      }
    }
  }
  const sharer = sharers.get(id);
  if (sharer) sharer.username = newName;
}

socket.on('user-renamed', ({ id, oldName, newName } = {}) => {
  if (typeof id !== 'string' || typeof newName !== 'string') return;
  applyRename(id, oldName, newName);
  systemMessage(oldName + ' agora se chama ' + newName);
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

function toggleWatch(id) {
  if (!inVoice) { systemMessage('Entre no canal de voz para assistir.'); return; }
  if (watching.has(id)) {
    socket.emit('unwatch', { to: id });
    watching.delete(id);
    removeScreenTile(id);
  } else {
    watching.add(id);
    socket.emit('watch', { to: id }, (res) => {
      if (!res || !res.ok) { // transmissão acabou de encerrar
        watching.delete(id);
        removeScreenTile(id);
      }
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

function updateLiveMode() {
  const live = $('screens').children.length > 0;
  $('screens').classList.toggle('hidden', !live);
  document.querySelector('.content').classList.toggle('live-mode', live);
}

function addScreenTile(id, stream, muted = false) {
  removeScreenTile(id);
  const tile = document.createElement('div');
  tile.className = 'screen-tile';
  tile.id = 'screen-' + id;
  let width = 420;
  const setWidth = (w) => {
    width = Math.max(240, Math.min(1400, w));
    tile.style.setProperty('--tile-w', width + 'px');
  };
  setWidth(width);
  // Zoom com o scroll do mouse sobre a live
  tile.addEventListener('wheel', (e) => {
    e.preventDefault();
    setWidth(width + (e.deltaY < 0 ? 60 : -60));
  }, { passive: false });

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = muted;
  video.srcObject = stream;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = id === selfId ? 'Sua tela' : voiceUserName(id);

  const controls = document.createElement('div');
  controls.className = 'controls';
  controls.append(tileButton('fullscreen', 'Tela cheia', () => video.requestFullscreen?.().catch(() => {})));
  video.ondblclick = () => video.requestFullscreen?.().catch(() => {});

  tile.append(video, label, controls);
  $('screens').appendChild(tile);
  updateLiveMode();
}

function removeScreenTile(id) {
  document.getElementById('screen-' + id)?.remove();
  updateLiveMode();
}
