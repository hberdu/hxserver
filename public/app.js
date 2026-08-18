/* HX Chat — cliente: login, chat via Socket.IO, voz e tela via WebRTC mesh */
const socket = io();
const $ = (id) => document.getElementById(id);

let selfId = null;
let username = null;

// Reconexão: estado do servidor foi perdido (novo socket.id, sala esquecida) — recomeçar limpo
socket.io.on('reconnect', () => { if (username) location.reload(); });

// PWA: instalável como aplicativo (ícone na barra de endereço / menu do navegador)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('install-btn').classList.remove('hidden');
});
$('install-btn').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $('install-btn').classList.add('hidden');
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
};
let audioCtx = null;

function playSound(name) {
  const seq = SOUNDS[name];
  if (!seq) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
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
$('login-btn').onclick = () => auth('login');
$('register-btn').onclick = () => auth('register');
$('password-input').onkeydown = (e) => { if (e.key === 'Enter') auth('login'); };

function auth(event) {
  const u = $('username-input').value.trim();
  const p = $('password-input').value;
  if (!u || !p) { $('login-error').textContent = 'Preencha usuário e senha.'; return; }
  socket.emit(event, { username: u, password: p }, (res) => {
    if (!res || res.error) { $('login-error').textContent = (res && res.error) || 'Falha ao entrar.'; return; }
    selfId = res.selfId;
    username = res.username || u; // nome canônico do banco
    Object.entries(res.avatars || {}).forEach(([n, img]) => avatares.set(n, img));
    $('login-screen').classList.add('hidden');
    $('main-screen').classList.remove('hidden');
    $('self-name').textContent = username;
    $('self-avatar').replaceChildren(avatarEl(username, 28));
    res.messages.forEach(renderMessage);
    res.users.forEach((user) => addUser(user.id, user.username));
    res.voiceUsers.forEach((user) => addVoiceUser(user.id, user.username, user.muted));
    res.sharers.forEach((s) => {
      sharers.set(s.id, { username: s.username, thumb: s.thumb });
      updateBadge(s.id, true);
    });
    scrollMessages();
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

function renderMessage({ username: author, text, ts }) {
  const div = document.createElement('div');
  div.className = 'message';
  const time = new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const meta = document.createElement('div');
  meta.className = 'meta';
  const authorSpan = document.createElement('span');
  authorSpan.className = 'author';
  authorSpan.textContent = author;
  const timeSpan = document.createElement('span');
  timeSpan.className = 'time';
  timeSpan.textContent = time;
  meta.append(authorSpan, timeSpan);
  const textDiv = document.createElement('div');
  textDiv.className = 'text';
  textDiv.textContent = text;
  const body = document.createElement('div');
  body.className = 'body';
  body.append(meta, textDiv);
  div.append(avatarEl(author, 36), body);
  $('messages').appendChild(div);
}

function systemMessage(text) {
  const div = document.createElement('div');
  div.className = 'message system';
  div.textContent = text;
  $('messages').appendChild(div);
  scrollMessages();
}

function scrollMessages() {
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}

socket.on('chat-message', (msg) => { renderMessage(msg); scrollMessages(); });

// ---------- Lista de usuários ----------
function addUser(id, name) {
  if (document.getElementById('user-' + id)) return;
  const li = document.createElement('li');
  li.id = 'user-' + id;
  const span = document.createElement('span');
  span.textContent = name;
  li.append(avatarEl(name, 26), span);
  $('user-list').appendChild(li);
}

socket.on('user-joined', ({ id, username: name }) => { addUser(id, name); systemMessage(name + ' entrou no servidor'); });
socket.on('user-left', ({ id, username: name }) => {
  document.getElementById('user-' + id)?.remove();
  removeVoiceUser(id);
  removePeer(id);
  sharerGone(id);
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

function addVoiceUser(id, name, muted = false) {
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
  li.append(avatarEl(name, 24), span, muteInd);
  li.classList.toggle('muted', muted);
  $('voice-users').appendChild(li);
  if (sharers.has(id)) updateBadge(id, true);
}

function setVoiceMuted(id, muted) {
  document.getElementById('voice-user-' + id)?.classList.toggle('muted', !!muted);
}

socket.on('user-muted', ({ id, muted } = {}) => setVoiceMuted(id, muted));

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
$('screen-btn').onclick = toggleScreen;

async function joinVoice() {
  if (inVoice) return;
  inVoice = true; // antes do await: bloqueia duplo clique durante o prompt do microfone
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    attachSpeaking(selfId, localStream);
    // Novato inicia a conexão com cada participante já presente
    res.peers.forEach(({ id }) => getPeer(id));
    if (previewId) updatePreview();
  });
}

function leaveVoice() {
  if (!inVoice) return;
  inVoice = false;
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
  $('mute-icon').setAttribute('href', '#i-mic');
  playSound('leave');
  if (previewId) updatePreview();
}

function toggleMute() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  $('mute-btn').classList.toggle('active', !track.enabled);
  $('mute-icon').setAttribute('href', track.enabled ? '#i-mic' : '#i-mic-off');
  setVoiceMuted(selfId, !track.enabled);
  socket.emit('set-muted', { muted: !track.enabled });
  playSound(track.enabled ? 'unmute' : 'mute');
}

socket.on('voice-user-joined', ({ id, username: name }) => {
  addVoiceUser(id, name);
  systemMessage(name + ' entrou no canal de voz');
  // Conexão criada sob demanda quando a oferta do novato chegar
});

socket.on('voice-user-left', ({ id }) => {
  removeVoiceUser(id);
  removePeer(id);
  sharerGone(id);
  if (inVoice) playSound('leave');
});

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
    meters.set(id, { analyser, data: new Uint8Array(analyser.frequencyBinCount), src });
    if (!meterTimer) meterTimer = setInterval(pollSpeaking, 120);
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

function pollSpeaking() {
  meters.forEach((m, id) => {
    m.analyser.getByteTimeDomainData(m.data);
    let sum = 0;
    for (const v of m.data) { const d = v - 128; sum += d * d; }
    voiceAvatar(id)?.classList.toggle('speaking', Math.sqrt(sum / m.data.length) > 4);
  });
}

// ---------- WebRTC mesh (negociação perfeita) ----------
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
// ponytail: só STUN; atrás de NAT simétrico precisa de TURN — adicionar credenciais aqui

function getPeer(peerId) {
  if (peers.has(peerId)) return peers.get(peerId);

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const state = { pc, makingOffer: false, ignoreOffer: false, polite: selfId < peerId };
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
    if (pc.connectionState === 'failed') pc.restartIce(); // re-oferta flui pela negociação perfeita
    else if (pc.connectionState === 'closed') removePeer(peerId);
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
      const offerCollision = data.description.type === 'offer' &&
        (state.makingOffer || pc.signalingState !== 'stable');
      state.ignoreOffer = !state.polite && offerCollision;
      if (state.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
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
  viewerSenders.forEach((sender, viewerId) => {
    try { peers.get(viewerId)?.pc.removeTrack(sender); } catch { /* pc já fechado */ }
  });
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
  const peer = peers.get(from);
  if (!peer || viewerSenders.has(from)) return;
  const sender = peer.pc.addTrack(screenStream.getVideoTracks()[0], screenStream);
  viewerSenders.set(from, sender);
  preferBestCodec(peer.pc, sender);
  retuneSenders();
  setTimeout(retuneSenders, 2000); // encodings só existem após a negociação completar
});

socket.on('watch-stop', ({ from } = {}) => {
  const sender = viewerSenders.get(from);
  if (!sender) return;
  viewerSenders.delete(from);
  try { peers.get(from)?.pc.removeTrack(sender); } catch { /* pc já fechado */ }
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
  if (watching.has(previewId)) {
    socket.emit('unwatch', { to: previewId });
    watching.delete(previewId);
    removeScreenTile(previewId);
  } else {
    const id = previewId;
    watching.add(id);
    socket.emit('watch', { to: id }, (res) => {
      if (!res || !res.ok) { // transmissão acabou de encerrar
        watching.delete(id);
        removeScreenTile(id);
        if (previewId === id) updatePreview();
      }
    });
    closePreview();
    return;
  }
  updatePreview();
};

// ---------- Editar perfil (foto) ----------
$('user-footer').onclick = () => {
  $('profile-avatar-holder').replaceChildren(avatarEl(username, 96));
  $('rename-input').value = username;
  $('profile-error').textContent = '';
  $('profile-overlay').classList.remove('hidden');
};

$('avatar-remove').onclick = () => {
  socket.emit('set-avatar', { img: null }, (res) => {
    if (!res || res.error) { $('profile-error').textContent = (res && res.error) || 'Falha ao remover.'; return; }
    avatares.delete(username);
    refreshAvatars(username);
    $('profile-avatar-holder').replaceChildren(avatarEl(username, 96));
  });
};

function applyRename(id, oldName, newName) {
  const photo = avatares.get(oldName);
  if (photo) { avatares.set(newName, photo); avatares.delete(oldName); }
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
    $('profile-avatar-holder').replaceChildren(avatarEl(username, 96));
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
    $('profile-avatar-holder').replaceChildren(avatarEl(username, 96));
  });
};

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
  const expandBtn = tileButton('expand', 'Expandir', () => {
    const focused = tile.classList.toggle('focused');
    expandBtn.querySelector('use').setAttribute('href', focused ? '#i-shrink' : '#i-expand');
  });
  controls.append(
    expandBtn,
    tileButton('fullscreen', 'Tela cheia', () => video.requestFullscreen?.().catch(() => {})),
  );
  video.ondblclick = () => video.requestFullscreen?.().catch(() => {});

  tile.append(video, label, controls);
  $('screens').appendChild(tile);
  updateLiveMode();
}

function removeScreenTile(id) {
  document.getElementById('screen-' + id)?.remove();
  updateLiveMode();
}
