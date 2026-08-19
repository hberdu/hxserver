const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { maxHttpBufferSize: 300 * 1024 }); // thumbnails cabem, payloads gigantes não

app.use(express.static('public'));

// ---------- Banco: usuários com senha em hash scrypt (irreversível) ----------
const db = new DatabaseSync(process.env.HX_DB || path.join(__dirname, 'hx.db'));
db.exec(`CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL
)`);
try { db.exec('ALTER TABLE users ADD COLUMN avatar TEXT'); } catch { /* coluna já existe */ }
const insertUser = db.prepare('INSERT INTO users (username, salt, hash) VALUES (?, ?, ?)');
const getUser = db.prepare('SELECT username, salt, hash FROM users WHERE username = ?');
const getAvatar = db.prepare('SELECT avatar FROM users WHERE username = ?');
const setAvatar = db.prepare('UPDATE users SET avatar = ? WHERE username = ?');
const renameUser = db.prepare('UPDATE users SET username = ? WHERE username = ?');
const updateHash = db.prepare('UPDATE users SET hash = ? WHERE username = ?');

// Sessões: sobrevivem a restart do servidor, então um deploy não joga ninguém na tela de login.
// Guarda só o hash do token — vazamento do banco não vira login.
db.exec('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, created INTEGER NOT NULL)');
const insertSession = db.prepare('INSERT INTO sessions (token, username, created) VALUES (?, ?, ?)');
const getSession = db.prepare('SELECT username, created FROM sessions WHERE token = ?');
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
const renameSessions = db.prepare('UPDATE sessions SET username = ? WHERE username = ?');
const SESSION_MAX_AGE = 30 * 24 * 3600 * 1000;
db.prepare('DELETE FROM sessions WHERE created < ?').run(Date.now() - SESSION_MAX_AGE);

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function newSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  insertSession.run(tokenHash(token), username, Date.now());
  return token;
}

function sessionUser(token) {
  if (typeof token !== 'string' || token.length !== 64) return null;
  const key = tokenHash(token);
  const row = getSession.get(key);
  if (!row) return null;
  if (Date.now() - row.created > SESSION_MAX_AGE) { deleteSession.run(key); return null; }
  return row.username;
}

// Async: hashing roda no threadpool, não trava o event loop (chat/sinalização seguem fluindo).
// Memória por hash = 128 * N * r. Com N=2^15,r=8 são ~34MB; 4 threads = ~134MB, cabe em host de 512MB.
// (N=2^17 usava 134MB por hash = 536MB com 4 logins simultâneos: o processo era morto por OOM.)
const scrypt = require('util').promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }; // OWASP: N=2^15, r=8, p=3
const LEGACY_SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }; // hashes antigos

// Formato: "s2$N$r$p$<hex>". Hashes antigos são hex puro e migram no primeiro login.
async function hashPassword(password, saltHex, opts = SCRYPT) {
  const hex = (await scrypt(password, Buffer.from(saltHex, 'hex'), 64, opts)).toString('hex');
  return `s2$${opts.N}$${opts.r}$${opts.p}$${hex}`;
}

function parseStored(stored) {
  if (!stored.startsWith('s2$')) return { opts: LEGACY_SCRYPT, hex: stored, legacy: true };
  const [, N, r, p, hex] = stored.split('$');
  return { opts: { N: +N, r: +r, p: +p, maxmem: 128 * +N * +r * 2 }, hex, legacy: false };
}

async function createUser(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  insertUser.run(username, salt, await hashPassword(password, salt));
}

async function checkPassword(username, password) {
  const row = getUser.get(username);
  if (!row) return null;
  const { opts, hex, legacy } = parseStored(row.hash);
  const candidate = await hashPassword(password, row.salt, opts);
  const a = Buffer.from(candidate.split('$').pop(), 'hex');
  const b = Buffer.from(hex, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (legacy) { // re-hash com os parâmetros novos, sem pedir nada ao usuário
    try { updateHash.run(await hashPassword(password, row.salt), row.username); } catch { /* migra no próximo login */ }
  }
  return row.username;
}

// ---------- Estado do servidor único "HX" (em memória) ----------
// ponytail: memória volátil; persistir mensagens no sqlite se precisar sobreviver a restart
const SERVER_NAME = 'HX';
const state = {
  users: new Map(),    // socketId -> username
  messages: [],
  voice: new Set(),    // socketIds no canal de voz
  muted: new Set(),    // socketIds mutados
  deafened: new Set(), // socketIds com o canal silenciado (não ouvem ninguém)
  sharing: new Set(),  // socketIds transmitindo tela
  thumbs: new Map(),   // socketId -> último thumbnail (data URL)
};

const MAX_NAME = 32;
const MIN_NAME = 3;
const MIN_PASS = 6;
const MAX_PASS = 72;
const MAX_MSG = 2000;
const MAX_HISTORY = 100;
const MAX_THUMB = 200 * 1024; // ~200KB por thumbnail
const MAX_AVATAR = 100 * 1024; // ~100KB por foto de perfil

function validImage(img, max) {
  return typeof img === 'string' && img.length <= max &&
    (img.startsWith('data:image/jpeg;base64,') || img.startsWith('data:image/webp;base64,') || img.startsWith('data:image/png;base64,'));
}

function cleanCreds(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { username, password } = payload;
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const u = username.trim();
  if (u.length < MIN_NAME || u.length > MAX_NAME) return { error: `Usuário deve ter entre ${MIN_NAME} e ${MAX_NAME} caracteres.` };
  if (password.length < MIN_PASS || password.length > MAX_PASS) return { error: `Senha deve ter entre ${MIN_PASS} e ${MAX_PASS} caracteres.` };
  return { username: u, password };
}

function userList() {
  return [...state.users.entries()].map(([id, username]) => ({ id, username }));
}

io.on('connection', (socket) => {
  // Erro em um evento não pode derrubar o processo inteiro: isola cada handler
  const on = (event, handler) => socket.on(event, async (...args) => {
    try {
      await handler(...args);
    } catch (err) {
      console.error(`[socket:${event}]`, err);
      const ack = args[args.length - 1];
      if (typeof ack === 'function') ack({ error: 'Erro interno. Tente novamente.' });
    }
  });
  let username = null;
  const loggedIn = () => username !== null;

  function enterServer(name, ack, token) {
    username = name;
    state.users.set(socket.id, username);
    socket.join(SERVER_NAME);
    // Fotos de perfil de quem está online e de quem aparece no histórico
    const names = new Set([...state.users.values(), ...state.messages.map((m) => m.username)]);
    const avatars = {};
    for (const n of names) {
      const row = getAvatar.get(n);
      if (row && row.avatar) avatars[n] = row.avatar;
    }
    ack({
      avatars,
      ok: true,
      server: SERVER_NAME,
      token: token === undefined ? newSession(name) : token,
      selfId: socket.id,
      username, // nome canônico do banco (login "ANA" -> "ana")
      messages: state.messages,
      users: userList(),
      voiceUsers: [...state.voice].map((id) => ({ id, username: state.users.get(id), muted: state.muted.has(id), deafened: state.deafened.has(id) })),
      sharers: [...state.sharing].map((id) => ({ id, username: state.users.get(id), thumb: state.thumbs.get(id) || null })),
    });
    socket.to(SERVER_NAME).emit('user-joined', { id: socket.id, username });
  }

  on('register', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (loggedIn()) return ack({ error: 'Você já está conectado.' });
    const c = cleanCreds(payload);
    if (!c) return ack({ error: 'Preencha usuário e senha.' });
    if (c.error) return ack({ error: c.error });
    try {
      await createUser(c.username, c.password);
    } catch (err) {
      return ack({ error: 'Esse nome de usuário já existe.' });
    }
    if (loggedIn()) return ack({ error: 'Você já está conectado.' }); // logou por outra via durante o hash
    enterServer(c.username, ack);
  });

  on('login', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (loggedIn()) return ack({ error: 'Você já está conectado.' });
    const c = cleanCreds(payload);
    if (!c || c.error) return ack({ error: 'Usuário ou senha inválidos.' });
    const name = await checkPassword(c.username, c.password);
    if (!name) return ack({ error: 'Usuário ou senha inválidos.' });
    if (loggedIn()) return ack({ error: 'Você já está conectado.' });
    enterServer(name, ack);
  });

  // Volta direto ao servidor com o token guardado (após restart, refresh ou queda de rede)
  on('resume', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (loggedIn()) return ack({ error: 'Você já está conectado.' });
    const token = payload && payload.token;
    const name = sessionUser(token);
    if (!name) return ack({ error: 'Sessão expirada.' });
    enterServer(name, ack, token);
  });

  on('logout', (payload) => {
    const token = payload && payload.token;
    if (typeof token === 'string' && token.length === 64) deleteSession.run(tokenHash(token));
  });

  on('set-avatar', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (!loggedIn()) return ack({ error: 'Faça login primeiro.' });
    const img = payload && payload.img;
    if (img !== null && !validImage(img, MAX_AVATAR)) return ack({ error: 'Imagem inválida (JPEG/PNG/WebP, máx. 100KB).' });
    setAvatar.run(img, username); // null remove a foto
    ack({ ok: true });
    socket.to(SERVER_NAME).emit('avatar-changed', { username, avatar: img });
  });

  on('rename', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (!loggedIn()) return ack({ error: 'Faça login primeiro.' });
    const raw = payload && payload.username;
    if (typeof raw !== 'string') return ack({ error: 'Nome inválido.' });
    const name = raw.trim();
    if (name.length < MIN_NAME || name.length > MAX_NAME) return ack({ error: `Nome deve ter entre ${MIN_NAME} e ${MAX_NAME} caracteres.` });
    try {
      renameUser.run(name, username);
      renameSessions.run(name, username); // sessões existentes continuam válidas
    } catch {
      return ack({ error: 'Esse nome já existe.' });
    }
    const oldName = username;
    username = name;
    state.users.set(socket.id, username);
    ack({ ok: true, username });
    socket.to(SERVER_NAME).emit('user-renamed', { id: socket.id, oldName, newName: name });
  });

  on('chat-message', (payload) => {
    if (!loggedIn()) return;
    const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text || text.length > MAX_MSG) return;
    const msg = { username, text, ts: Date.now() };
    state.messages.push(msg);
    if (state.messages.length > MAX_HISTORY) state.messages.shift();
    io.to(SERVER_NAME).emit('chat-message', msg);
  });

  on('join-voice', (ack) => {
    if (typeof ack !== 'function') return;
    if (!loggedIn()) return ack({ error: 'Faça login primeiro.' });
    const already = state.voice.has(socket.id);
    const peers = [...state.voice]
      .filter((id) => id !== socket.id)
      .map((id) => ({ id, username: state.users.get(id) }));
    state.voice.add(socket.id);
    ack({ peers });
    if (!already) socket.to(SERVER_NAME).emit('voice-user-joined', { id: socket.id, username });
  });

  on('set-muted', (payload) => {
    if (!loggedIn() || !state.voice.has(socket.id)) return;
    const muted = !!(payload && payload.muted);
    if (muted) state.muted.add(socket.id);
    else state.muted.delete(socket.id);
    socket.to(SERVER_NAME).emit('user-muted', { id: socket.id, muted });
  });

  on('set-deafened', (payload) => {
    if (!loggedIn() || !state.voice.has(socket.id)) return;
    const deafened = !!(payload && payload.deafened);
    if (deafened) state.deafened.add(socket.id);
    else state.deafened.delete(socket.id);
    socket.to(SERVER_NAME).emit('user-deafened', { id: socket.id, deafened });
  });

  function stopSharing() {
    if (state.sharing.delete(socket.id)) {
      state.thumbs.delete(socket.id);
      socket.to(SERVER_NAME).emit('screen-share', { id: socket.id, username, on: false });
    }
  }

  function leaveVoice() {
    stopSharing();
    state.muted.delete(socket.id);
    state.deafened.delete(socket.id);
    if (state.voice.delete(socket.id)) {
      socket.to(SERVER_NAME).emit('voice-user-left', { id: socket.id });
    }
  }

  on('leave-voice', leaveVoice);

  // Relay de sinalização WebRTC: só entre membros do canal de voz
  on('signal', (payload) => {
    const { to, data } = payload || {};
    if (!loggedIn() || typeof to !== 'string') return;
    if (!state.voice.has(socket.id) || !state.voice.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  on('screen-share', (payload) => {
    if (!loggedIn() || !state.voice.has(socket.id)) return;
    const on = !!(payload && payload.on);
    if (on) {
      state.sharing.add(socket.id);
      socket.to(SERVER_NAME).emit('screen-share', { id: socket.id, username, on: true });
    } else {
      stopSharing();
    }
  });

  // Thumbnail periódico da transmissão (prévia antes de assistir)
  on('screen-thumb', (payload) => {
    if (!state.sharing.has(socket.id)) return;
    const img = payload && payload.img;
    if (!validImage(img, MAX_THUMB)) return;
    state.thumbs.set(socket.id, img);
    socket.to(SERVER_NAME).emit('screen-thumb', { id: socket.id, img });
  });

  // Espectador pede/encerra a transmissão de alguém (vídeo só vai para quem assiste)
  on('watch', (payload, ack) => {
    const to = payload && payload.to;
    const ok = typeof to === 'string' && state.voice.has(socket.id) && state.sharing.has(to);
    if (ok) io.to(to).emit('watch-request', { from: socket.id });
    if (typeof ack === 'function') ack({ ok });
  });

  on('unwatch', (payload) => {
    const to = payload && payload.to;
    if (typeof to !== 'string' || !state.voice.has(to)) return;
    io.to(to).emit('watch-stop', { from: socket.id });
  });

  on('disconnect', () => {
    if (!loggedIn()) return;
    leaveVoice();
    state.users.delete(socket.id);
    socket.to(SERVER_NAME).emit('user-left', { id: socket.id, username });
  });
});

// Health check: permite ping externo (evita hibernação em hospedagem free) e monitoramento
app.get('/healthz', (req, res) => {
  const mb = (n) => Math.round(n / 1048576);
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    online: state.users.size,
    voice: state.voice.size,
    sharing: state.sharing.size,
    memoryMB: { rss: mb(process.memoryUsage().rss), heap: mb(process.memoryUsage().heapUsed) },
  });
});

// Último recurso: registra e segue vivo em vez de derrubar todo mundo do servidor
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  httpServer.listen(PORT, () => console.log(`HX Chat rodando em http://localhost:${PORT}`));

  // Deploy/restart: avisa os clientes antes de cair, para reconectarem sem tela de erro
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      io.emit('server-restarting');
      setTimeout(() => { io.close(); httpServer.close(() => process.exit(0)); }, 300);
    });
  }
}

module.exports = { httpServer, io, state, db };
