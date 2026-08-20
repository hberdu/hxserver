const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { DatabaseSync } = require('node:sqlite');

const app = express();
app.disable('x-powered-by'); // não anunciar o stack
const httpServer = http.createServer(app);
const io = new Server(httpServer, { maxHttpBufferSize: 300 * 1024 }); // thumbnails cabem, payloads gigantes não

// ---------- Defesa por IP (sobrevive à reconexão: o bucket por-socket não bastava) ----------
// IP real atrás do proxy do Render vem no x-forwarded-for.
function clientIp(handshake) {
  const fwd = handshake.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0].trim() : handshake.address) || 'desconhecido';
}

// Folgado de propósito: amigos atrás do mesmo NAT (casa/faculdade) compartilham IP público.
const MAX_CONN_PER_IP = 50;         // conexões simultâneas por IP: barra flood de sockets/OOM
const connCount = new Map();        // ip -> nº de sockets abertos

// Bucket de tentativas de AUTH por IP, persistente entre conexões (o de socket zerava ao reconectar).
// Cobre register/login/resume: brute-force de senha e DoS de scrypt agora têm teto real por origem.
const authBuckets = new Map();      // ip -> { tokens, last }
const AUTH_MAX = 30;                // rajada de ~30 (vários amigos logando juntos após deploy)...
const AUTH_REFILL = 0.5;            // ...e recarga de 1 a cada 2s: brute-force sustentado inviável
function authAllow(ip) {
  const now = Date.now();
  const b = authBuckets.get(ip) || { tokens: AUTH_MAX, last: now };
  b.tokens = Math.min(AUTH_MAX, b.tokens + Math.max(0, now - b.last) / 1000 * AUTH_REFILL);
  b.last = now;
  authBuckets.set(ip, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
// Limpeza periódica dos buckets ociosos (não vazar memória com IPs que sumiram)
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of authBuckets) if (now - b.last > 3600_000) authBuckets.delete(ip);
}, 3600_000).unref();

// Semáforo global de scrypt: no máx 2 hashes concorrentes. Sem isso, um flood de logins satura
// as 4 threads do libuv e trava todo login/registro legítimo (e qualquer outro uso do threadpool).
let scryptActive = 0;
const scryptQueue = [];
function scryptSlot() {
  if (scryptActive < 2) { scryptActive++; return Promise.resolve(); }
  return new Promise((resolve) => scryptQueue.push(resolve));
}
function scryptRelease() {
  scryptActive--;
  const next = scryptQueue.shift();
  if (next) { scryptActive++; next(); }
}

// Handshake: bloqueia origem estranha (CSWSH) e limita conexões por IP.
const ALLOW_ORIGIN = null; // null = aceita só a mesma origem do app (comportamento fixo)
io.use((socket, next) => {
  const origin = socket.handshake.headers.origin;
  if (origin) { // requisição de browser: precisa bater com a origem do app
    if (ALLOW_ORIGIN) {
      if (origin !== ALLOW_ORIGIN) return next(new Error('origem não autorizada'));
    } else { // sem env: aceita só mesma origem, comparando hostname (porta implícita 80/443 varia)
      const host = (socket.handshake.headers.host || '').split(':')[0];
      try { if (new URL(origin).hostname !== host) return next(new Error('origem não autorizada')); }
      catch { return next(new Error('origem inválida')); }
    }
  }
  const ip = clientIp(socket.handshake);
  const n = connCount.get(ip) || 0;
  if (n >= MAX_CONN_PER_IP) return next(new Error('muitas conexões'));
  connCount.set(ip, n + 1);
  socket.on('disconnect', () => {
    const c = (connCount.get(ip) || 1) - 1;
    if (c <= 0) connCount.delete(ip); else connCount.set(ip, c);
  });
  next();
});

// Cabeçalhos de segurança. CSP estrita é viável aqui: scripts/CSS same-origin, imagens em data:,
// estilo só via CSSOM (não bloqueado). Com token em localStorage, CSP é o cinto contra XSS futuro.
app.use((req, res, next) => {
  // connect-src 'self' cobre socket.io same-origin (polling e ws/wss same-origin casam sob 'self');
  // sem ws:/wss: amplos, um XSS não teria por onde exfiltrar para host externo
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');             // sem iframe: bloqueia clickjacking
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');      // URL do servidor não vaza em links clicados
  res.setHeader('Strict-Transport-Security', 'max-age=31536000'); // ignorado em http local
  next();
});
app.use(express.static('public'));

// Registro público: qualquer um cria conta (grupo de amigos, sem convite). Anti-abuso fica por
// conta do rate limit por IP + cap de conexões, não de um gate de acesso.

// ---------- Banco: usuários com senha em hash scrypt (irreversível) ----------
const DB_PATH = process.env.HX_DB || path.join(__dirname, 'hx.db');
console.log(`[db] usando ${DB_PATH}${process.env.HX_DB ? '' : ' (ATENÇÃO: HX_DB não definido — efêmero em produção)'}`);
const db = new DatabaseSync(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL
)`);
try { db.exec('ALTER TABLE users ADD COLUMN avatar TEXT'); } catch { /* coluna já existe */ }
try { db.exec('ALTER TABLE users ADD COLUMN created INTEGER'); } catch { /* coluna já existe */ }
const insertUser = db.prepare('INSERT INTO users (username, salt, hash, created) VALUES (?, ?, ?, ?)');
const getUserInfo = db.prepare('SELECT username, created FROM users WHERE username = ?');
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
const deleteUserSessions = db.prepare('DELETE FROM sessions WHERE username = ?');
const SESSION_MAX_AGE = 30 * 24 * 3600 * 1000;
db.prepare('DELETE FROM sessions WHERE created < ?').run(Date.now() - SESSION_MAX_AGE);

// Mensagens persistidas: chat sobrevive a restart/deploy (mesma durabilidade das contas)
db.exec(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
)`);
try { db.exec('ALTER TABLE messages ADD COLUMN img TEXT'); } catch { /* coluna já existe */ }
try { db.exec('ALTER TABLE messages ADD COLUMN edited INTEGER'); } catch { /* coluna já existe */ }
try { db.exec("ALTER TABLE messages ADD COLUMN server TEXT NOT NULL DEFAULT 'hx'"); } catch { /* coluna já existe */ }
const insertMsg = db.prepare('INSERT INTO messages (username, text, ts, img, server) VALUES (?, ?, ?, ?, ?)');
// Trim por servidor: cada servidor mantém as próprias 100 mensagens
const trimMsgs = db.prepare('DELETE FROM messages WHERE server = ? AND id <= (SELECT MAX(id) FROM messages WHERE server = ?) - ?');
const historyFor = db.prepare(`SELECT id, username, text, ts, img, edited FROM
  (SELECT * FROM messages WHERE server = ? ORDER BY id DESC LIMIT 100) ORDER BY id ASC`);
const updateMsg = db.prepare('UPDATE messages SET text = ?, edited = 1 WHERE id = ? AND username = ?');
const deleteMsg = db.prepare('DELETE FROM messages WHERE id = ? AND username = ?');
const renameMsgs = db.prepare('UPDATE messages SET username = ? WHERE username = ?');
const allUsernames = db.prepare('SELECT username FROM users');

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
  await scryptSlot(); // no máx 2 scrypts concorrentes: não deixa flood de login travar o threadpool
  try {
    const hex = (await scrypt(password, Buffer.from(saltHex, 'hex'), 64, opts)).toString('hex');
    return `s2$${opts.N}$${opts.r}$${opts.p}$${hex}`;
  } finally {
    scryptRelease();
  }
}

function parseStored(stored) {
  if (!stored.startsWith('s2$')) return { opts: LEGACY_SCRYPT, hex: stored, legacy: true };
  const [, N, r, p, hex] = stored.split('$');
  return { opts: { N: +N, r: +r, p: +p, maxmem: 128 * +N * +r * 2 }, hex, legacy: false };
}

async function createUser(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  insertUser.run(username, salt, await hashPassword(password, salt), Date.now());
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
const MAX_HISTORY = 100;
const shareStart = new Map(); // socketId -> ts do início da transmissão (para log de duração)

// Servidores fixos, cada um com um canal de texto "geral" e suas salas de voz. O servidor é a fonte:
// o cliente renderiza tudo a partir do que vem no ack, então mexer aqui basta para add/renomear.
const SERVERS = [
  { id: 'hx', name: 'HX', voiceRooms: [
    { id: 'akon', name: 'akon_lonely_brega.mp3' },
    { id: 'tibia', name: 'Tibia' },
  ] },
  { id: 'panteras', name: 'Panteras', voiceRooms: [
    { id: 'pan-1', name: 'Sala 1' }, { id: 'pan-2', name: 'Sala 2' }, { id: 'pan-3', name: 'Sala 3' },
  ] },
  { id: 'serverb', name: 'Lady Club', voiceRooms: [
    { id: 'b-1', name: 'Sala 1' }, { id: 'b-2', name: 'Sala 2' }, { id: 'b-3', name: 'Sala 3' },
  ] },
];
const SERVER_IDS = new Set(SERVERS.map((s) => s.id));
const DEFAULT_SERVER = SERVERS[0].id;
const ROOM_SERVER = new Map();     // roomId -> serverId (sala pertence a um servidor)
const VOICE_ROOM_IDS = new Set();
for (const s of SERVERS) for (const r of s.voiceRooms) { ROOM_SERVER.set(r.id, s.id); VOICE_ROOM_IDS.add(r.id); }
const srvRoom = (serverId) => 'srv:' + serverId; // sala do socket.io que agrupa quem vê aquele servidor

const state = {
  users: new Map(),    // socketId -> username (online global)
  viewing: new Map(),  // socketId -> serverId que está vendo agora (1 por vez)
  messages: {},        // serverId -> array das últimas mensagens (carregado do banco por servidor)
  voice: new Map(),    // socketId -> roomId em que está (no máx. 1 sala por vez, como no Discord)
  muted: new Set(),    // socketIds mutados
  deafened: new Set(), // socketIds com o canal silenciado (não ouvem ninguém)
  sharing: new Set(),  // socketIds transmitindo tela
  thumbs: new Map(),   // socketId -> último thumbnail (data URL)
};
for (const s of SERVERS) state.messages[s.id] = historyFor.all(s.id);

// Peers da MESMA sala (o mesh WebRTC se forma só dentro de cada sala)
function voicePeers(room, exceptId) {
  const out = [];
  for (const [id, r] of state.voice) if (r === room && id !== exceptId) out.push({ id, username: state.users.get(id) });
  return out;
}

// Retrato do servidor para o cliente montar a tela ao entrar/trocar
function serverSnapshot(serverId) {
  const srv = SERVERS.find((s) => s.id === serverId);
  const here = (id) => state.viewing.get(id) === serverId;
  const inRoom = (id) => state.voice.has(id) && ROOM_SERVER.get(state.voice.get(id)) === serverId;
  return {
    server: serverId,
    serverName: srv.name,
    voiceRooms: srv.voiceRooms,
    messages: state.messages[serverId],
    users: [...state.users].filter(([id]) => here(id)).map(([id, username]) => ({ id, username })),
    voiceUsers: [...state.voice].filter(([id]) => inRoom(id))
      .map(([id, room]) => ({ id, username: state.users.get(id), muted: state.muted.has(id), deafened: state.deafened.has(id), room })),
    sharers: [...state.sharing].filter((id) => here(id)).map((id) => ({ id, username: state.users.get(id), thumb: state.thumbs.get(id) || null })),
  };
}

const MAX_NAME = 32;
const MIN_NAME = 3;
const MIN_PASS = 6;
const MAX_PASS = 72;
const MAX_MSG = 2000;
const MAX_THUMB = 200 * 1024; // ~200KB por thumbnail
const MAX_AVATAR = 100 * 1024; // ~100KB por foto de perfil

function validImage(img, max) {
  if (typeof img !== 'string' || img.length > max) return false;
  // Valida também o corpo base64: sem isso, lixo arbitrário persiste como avatar/thumb quebrado
  const m = img.match(/^data:image\/(?:jpeg|webp|png);base64,([A-Za-z0-9+/]+={0,2})$/);
  return !!m && m[1].length % 4 === 0;
}

// Caracteres especiais são liberados (símbolos, emoji, pontuação). Só bloqueia o que é perigoso e
// invisível: controle (C0/C1), zero-width, quebras de linha e overrides bidi — usados para se passar
// por outro membro ou falsear logs. Normaliza NFC para "á" composto/decomposto casarem.
// eslint-disable-next-line no-control-regex
const NAME_BAD = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/;
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const u = raw.normalize('NFC').trim();
  if (u.length < MIN_NAME || u.length > MAX_NAME) return { error: `Usuário deve ter entre ${MIN_NAME} e ${MAX_NAME} caracteres.` };
  if (NAME_BAD.test(u)) return { error: 'O nome tem caracteres invisíveis ou de controle não permitidos.' };
  return { username: u };
}

function cleanCreds(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { username, password } = payload;
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const n = cleanName(username);
  if (!n) return null;
  if (n.error) return n;
  if (password.length < MIN_PASS || password.length > MAX_PASS) return { error: `Senha deve ter entre ${MIN_PASS} e ${MAX_PASS} caracteres.` };
  return { username: n.username, password };
}

function userList() {
  return [...state.users.entries()].map(([id, username]) => ({ id, username }));
}

// Anti-flood: custo em tokens por evento.
// Bucket de 60 por socket, recarga 6/s: chat normal nunca esbarra, loop de spam esbarra em ~1s.
// signal custa 0.2: rajada legítima de ICE (entrar numa mesh cheia) passa; flood contínuo não.
const RATE_COST = {
  register: 20, login: 20, resume: 5,          // scrypt caro: limita brute-force e DoS de threadpool
  'chat-message': 2, typing: 1, 'edit-message': 2, 'delete-message': 2,
  'screen-thumb': 5, 'set-avatar': 10, rename: 10, // thumb legítimo é 1 a cada 3s: folga de sobra
  signal: 0.2,
  watch: 1, unwatch: 1, 'join-voice': 1, 'leave-voice': 1,
  'set-muted': 1, 'set-deafened': 1, 'screen-share': 1,
  logout: 1, 'get-profile': 1, 'ping-hx': 0.5, // ping legítimo é 1 a cada 5s: folga enorme
  'switch-server': 2, 'voice-roster': 0.5,
};
const RATE_MAX = 60;
const RATE_REFILL = 6; // tokens por segundo

io.on('connection', (socket) => {
  const ip = clientIp(socket.handshake);
  let rateTokens = RATE_MAX;
  let rateLast = Date.now();
  // Erro em um evento não pode derrubar o processo inteiro: isola cada handler
  const on = (event, handler) => socket.on(event, async (...args) => {
    const cost = RATE_COST[event] || 0;
    if (cost) {
      const now = Date.now();
      rateTokens = Math.min(RATE_MAX, rateTokens + Math.max(0, now - rateLast) / 1000 * RATE_REFILL);
      rateLast = now;
      if (rateTokens < cost) {
        const ack = args[args.length - 1];
        if (typeof ack === 'function') ack({ error: 'Muitas ações em pouco tempo. Aguarde um instante.' });
        else socket.emit('rate-limited', { event }); // sem ack: avisa para a mensagem não sumir muda
        return;
      }
      rateTokens -= cost;
    }
    try {
      await handler(...args);
    } catch (err) {
      console.error(`[socket:${event}]`, err);
      const ack = args[args.length - 1];
      if (typeof ack === 'function') ack({ error: 'Erro interno. Tente novamente.' });
    }
  });
  let username = null;
  // Também exige presença no estado: um socket derrubado por dropStale perde a voz na hora,
  // mesmo que eventos dele ainda cheguem antes do disconnect completar
  const loggedIn = () => username !== null && state.users.has(socket.id);
  const curServer = () => state.viewing.get(socket.id) || DEFAULT_SERVER; // servidor que este socket vê
  const toServer = () => socket.to(srvRoom(curServer()));   // broadcast p/ os OUTROS do meu servidor
  const inServer = () => io.to(srvRoom(curServer()));       // broadcast p/ TODOS do meu servidor (incl. eu)
  // Eventos de VOZ vão para o servidor DONO da sala (posso estar vendo outro servidor sem sair da call)
  const toVoice = () => socket.to(srvRoom(ROOM_SERVER.get(state.voice.get(socket.id))));

  // Remove do estado uma conexão antiga da mesma conta (substituída ou já morta).
  // Deletes idempotentes: se o socket antigo ainda disparar 'disconnect', nada duplica.
  function dropStale(id, name) {
    const old = io.sockets.sockets.get(id);
    if (old) {
      old.emit('session-superseded');
      setTimeout(() => old.disconnect(true), 100); // aviso chega antes de fechar
    }
    const sv = state.viewing.get(id) || DEFAULT_SERVER;             // servidor que a conexão antiga via
    const voiceSv = srvRoom(ROOM_SERVER.get(state.voice.get(id)));  // servidor da sala de voz dela
    console.log(`[sessão] ${name}: conexão ${id} substituída por ${socket.id}`);
    state.users.delete(id);
    state.viewing.delete(id);
    state.muted.delete(id);
    state.deafened.delete(id);
    if (state.sharing.delete(id)) {
      state.thumbs.delete(id);
      const dur = Math.round((Date.now() - (shareStart.get(id) || Date.now())) / 1000);
      shareStart.delete(id);
      console.log(`[share] fim: ${name} após ${dur}s — motivo: sessão substituída por nova conexão da mesma conta`);
      io.to(voiceSv).emit('screen-share', { id, username: name, on: false });
    }
    if (state.voice.delete(id)) {
      console.log(`[voz] saiu: ${name} — motivo: sessão substituída por nova conexão da mesma conta`);
      io.to(voiceSv).emit('voice-user-left', { id });
    }
    io.to(srvRoom(sv)).emit('user-left', { id, username: name });
  }

  // Fotos de perfil de quem está online no MESMO servidor (evita ack gigante com blobs de todo mundo)
  function onlineAvatars(serverId) {
    const avatars = {};
    for (const [id, n] of state.users) {
      if (state.viewing.get(id) !== serverId) continue;
      const row = getAvatar.get(n);
      if (row && row.avatar) avatars[n] = row.avatar;
    }
    return avatars;
  }

  function enterServer(name, ack, token) {
    if (socket.disconnected) return; // caiu durante o scrypt: não registrar socket morto
    // Conexão nova substitui a antiga da mesma conta (evita fantasma duplicado após reconexão)
    for (const [id, n] of [...state.users]) {
      if (n === name && id !== socket.id) dropStale(id, n);
    }
    username = name;
    state.users.set(socket.id, username);
    state.viewing.set(socket.id, DEFAULT_SERVER);
    socket.join('all');                    // eventos globais (avatar/rename)
    socket.join(srvRoom(DEFAULT_SERVER));   // eventos do servidor visto
    ack({
      ok: true,
      token: token === undefined ? newSession(name) : token,
      selfId: socket.id,
      username, // nome canônico do banco (login "ANA" -> "ana")
      servers: SERVERS.map((s) => ({ id: s.id, name: s.name })), // barra de servidores
      allUsers: allUsernames.all().map((r) => r.username),       // membros (seção offline)
      avatars: onlineAvatars(DEFAULT_SERVER),
      ...serverSnapshot(DEFAULT_SERVER),
    });
    const own = getAvatar.get(username);
    socket.to(srvRoom(DEFAULT_SERVER)).emit('user-joined', { id: socket.id, username, avatar: (own && own.avatar) || null });
  }

  // Trocar de servidor muda só o que você VÊ (chat/membros). A voz continua na sala em que você está,
  // mesmo em outro servidor — dá para navegar sem cair da call (a presença de voz é por sala, não por view).
  function switchServer(sid, ack) {
    const from = state.viewing.get(socket.id);
    if (from === sid) return ack({ ok: true, avatars: onlineAvatars(sid), ...serverSnapshot(sid) });
    socket.leave(srvRoom(from));
    socket.to(srvRoom(from)).emit('user-left', { id: socket.id, username });
    state.viewing.set(socket.id, sid);
    socket.join(srvRoom(sid));
    ack({ ok: true, avatars: onlineAvatars(sid), ...serverSnapshot(sid) });
    const own = getAvatar.get(username);
    socket.to(srvRoom(sid)).emit('user-joined', { id: socket.id, username, avatar: (own && own.avatar) || null });
  }

  on('register', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (loggedIn()) return ack({ error: 'Você já está conectado.' });
    const c = cleanCreds(payload);
    if (!c) return ack({ error: 'Preencha usuário e senha.' });
    if (c.error) return ack({ error: c.error });
    // Duplicado (barato): responde antes do scrypt e sem gastar cota — colisão de nome não tranca o IP
    if (getUser.get(c.username)) return ack({ error: 'Esse nome de usuário já existe.' });
    // authAllow antes do scrypt: limita criação em massa de contas e DoS de hash por IP
    if (!authAllow(ip)) return ack({ error: 'Muitas tentativas. Aguarde alguns segundos.' });
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
    if (!authAllow(ip)) return ack({ error: 'Muitas tentativas. Aguarde alguns segundos.' });
    // Login NÃO aplica o regex de charset (só register/rename): uma conta antiga com nome fora
    // do allowlist ainda entra. Só normaliza e valida tamanho; o banco decide se existe.
    const u = payload && typeof payload.username === 'string' ? payload.username.normalize('NFC').trim() : '';
    const p = payload && typeof payload.password === 'string' ? payload.password : '';
    if (u.length < MIN_NAME || u.length > MAX_NAME || !p) return ack({ error: 'Usuário ou senha inválidos.' });
    const name = await checkPassword(u, p);
    if (!name) return ack({ error: 'Usuário ou senha inválidos.' });
    if (loggedIn()) return ack({ error: 'Você já está conectado.' });
    // Login com senha revoga todos os tokens antigos: é o "desconectar outros dispositivos"
    // e a recuperação para token roubado (o ladrão perde o acesso no próximo login legítimo)
    deleteUserSessions.run(name);
    enterServer(name, ack);
  });

  // Quem está em chamada num servidor (tooltip ao passar o mouse no ícone do servidor)
  on('voice-roster', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (!loggedIn()) return ack({ error: 'Faça login primeiro.' });
    const sid = payload && payload.server;
    const srv = SERVERS.find((s) => s.id === sid);
    if (!srv) return ack({ error: 'Servidor inválido.' });
    const users = [];
    for (const [id, room] of state.voice) {
      if (ROOM_SERVER.get(room) !== sid) continue;
      users.push({ id, username: state.users.get(id), room, muted: state.muted.has(id), deafened: state.deafened.has(id) });
    }
    ack({ ok: true, server: sid, rooms: srv.voiceRooms, users });
  });

  // Perfil público de um membro (modal ao clicar no usuário)
  on('get-profile', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (!loggedIn()) return ack({ error: 'Faça login primeiro.' });
    const name = payload && payload.username;
    if (typeof name !== 'string' || name.length > MAX_NAME) return ack({ error: 'Usuário inválido.' });
    const row = getUserInfo.get(name);
    if (!row) return ack({ error: 'Usuário não encontrado.' });
    ack({ ok: true, username: row.username, created: row.created || null });
  });

  // Volta direto ao servidor com o token guardado (após restart, refresh ou queda de rede)
  on('resume', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (loggedIn()) return ack({ error: 'Você já está conectado.' });
    if (!authAllow(ip)) return ack({ error: 'Muitas tentativas. Aguarde alguns segundos.' });
    const token = payload && payload.token;
    const name = sessionUser(token);
    if (!name) return ack({ error: 'Sessão expirada.' });
    // Rotaciona: descarta o token usado e emite um novo (janela de reuso de token roubado encurta).
    // enterServer com token=undefined gera uma sessão nova; o cliente já persiste res.token.
    deleteSession.run(tokenHash(token));
    enterServer(name, ack);
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
    socket.to('all').emit('avatar-changed', { username, avatar: img }); // foto é global (todos os servidores)
  });

  on('rename', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (!loggedIn()) return ack({ error: 'Faça login primeiro.' });
    const n = cleanName(payload && payload.username);
    if (!n) return ack({ error: 'Nome inválido.' });
    if (n.error) return ack({ error: n.error });
    const name = n.username;
    try {
      // 0 linhas = closure aponta para nome que não existe mais no banco (sessão dessincronizada)
      if (renameUser.run(name, username).changes === 0) return ack({ error: 'Sessão desatualizada. Recarregue a página.' });
      renameSessions.run(name, username); // sessões existentes continuam válidas
      renameMsgs.run(name, username);     // histórico segue editável e com avatar após o rename
    } catch {
      return ack({ error: 'Esse nome já existe.' });
    }
    const oldName = username;
    username = name;
    state.users.set(socket.id, username);
    // Nome antigo nas mensagens em memória (de todos os servidores) acompanha o rename
    for (const arr of Object.values(state.messages)) for (const m of arr) if (m.username === oldName) m.username = name;
    ack({ ok: true, username });
    socket.to('all').emit('user-renamed', { id: socket.id, oldName, newName: name }); // nome é global
  });

  on('chat-message', (payload) => {
    if (!loggedIn()) return;
    const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
    const img = payload && payload.img;
    const hasImg = img !== undefined && img !== null;
    if (hasImg && !validImage(img, MAX_THUMB)) return;
    if ((!text && !hasImg) || text.length > MAX_MSG) return;
    const sv = curServer();
    const ts = Date.now();
    const info = insertMsg.run(username, text, ts, hasImg ? img : null, sv);
    const msg = { id: Number(info.lastInsertRowid), username, text, ts };
    if (hasImg) msg.img = img;
    const arr = state.messages[sv];
    arr.push(msg);
    if (arr.length > MAX_HISTORY) arr.shift();
    trimMsgs.run(sv, sv, MAX_HISTORY);
    inServer().emit('chat-message', msg);
  });

  // Acha uma mensagem (e seu servidor) pelo id, em qualquer servidor
  function findMsg(id) {
    for (const [sv, arr] of Object.entries(state.messages)) {
      const m = arr.find((x) => x.id === id);
      if (m) return { sv, m };
    }
    return null;
  }

  // Editar/apagar: o WHERE username=? garante que só o autor mexe na própria mensagem
  on('edit-message', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (!loggedIn()) return ack({ error: 'Faça login primeiro.' });
    const id = payload && payload.id;
    const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!Number.isInteger(id) || !text || text.length > MAX_MSG) return ack({ error: 'Mensagem inválida.' });
    if (updateMsg.run(text, id, username).changes === 0) return ack({ error: 'Só dá para editar as próprias mensagens.' });
    const found = findMsg(id);
    if (found) { found.m.text = text; found.m.edited = 1; }
    ack({ ok: true });
    io.to(srvRoom(found ? found.sv : curServer())).emit('message-edited', { id, text });
  });

  on('delete-message', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (!loggedIn()) return ack({ error: 'Faça login primeiro.' });
    const id = payload && payload.id;
    if (!Number.isInteger(id)) return ack({ error: 'Mensagem inválida.' });
    if (deleteMsg.run(id, username).changes === 0) return ack({ error: 'Só dá para apagar as próprias mensagens.' });
    const found = findMsg(id);
    if (found) state.messages[found.sv] = state.messages[found.sv].filter((x) => x.id !== id);
    ack({ ok: true });
    io.to(srvRoom(found ? found.sv : curServer())).emit('message-deleted', { id });
  });

  // Trocar de servidor: recebe o retrato do novo (canal, salas de voz, mensagens, membros)
  on('switch-server', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (!loggedIn()) return ack({ error: 'Faça login primeiro.' });
    const sid = payload && payload.server;
    if (!SERVER_IDS.has(sid)) return ack({ error: 'Servidor inválido.' });
    switchServer(sid, ack);
  });

  // "Fulano está digitando…" — volatile: pode se perder na reconexão sem fazer falta
  on('typing', () => {
    if (loggedIn()) toServer().volatile.emit('typing', { username });
  });

  // Medição de latência: só devolve o ack para o cliente cronometrar o round-trip (custo ~0)
  on('ping-hx', (ack) => { if (typeof ack === 'function') ack(); });

  on('join-voice', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (!loggedIn()) return ack({ error: 'Faça login primeiro.' });
    const room = payload && payload.room;
    if (!VOICE_ROOM_IDS.has(room)) return ack({ error: 'Sala inválida.' });
    if (ROOM_SERVER.get(room) !== curServer()) return ack({ error: 'Sala de outro servidor.' }); // só salas do servidor visto
    if (state.voice.get(socket.id) === room) return ack({ peers: voicePeers(room, socket.id), room }); // já nesta sala
    if (state.voice.has(socket.id)) leaveVoice('trocou de sala'); // sai da sala anterior antes de entrar na nova
    state.voice.set(socket.id, room);
    ack({ peers: voicePeers(room, socket.id), room });
    toVoice().emit('voice-user-joined', { id: socket.id, username, room });
  });

  on('set-muted', (payload) => {
    if (!loggedIn() || !state.voice.has(socket.id)) return;
    const muted = !!(payload && payload.muted);
    if (muted) state.muted.add(socket.id);
    else state.muted.delete(socket.id);
    toVoice().emit('user-muted', { id: socket.id, muted });
  });

  on('set-deafened', (payload) => {
    if (!loggedIn() || !state.voice.has(socket.id)) return;
    const deafened = !!(payload && payload.deafened);
    if (deafened) state.deafened.add(socket.id);
    else state.deafened.delete(socket.id);
    toVoice().emit('user-deafened', { id: socket.id, deafened });
  });

  function stopSharing(reason = 'não especificado') {
    if (state.sharing.delete(socket.id)) {
      const dest = toVoice(); // captura a sala antes de qualquer limpeza
      state.thumbs.delete(socket.id);
      const dur = Math.round((Date.now() - (shareStart.get(socket.id) || Date.now())) / 1000);
      shareStart.delete(socket.id);
      console.log(`[share] fim: ${username} após ${dur}s — motivo: ${reason}`);
      dest.emit('screen-share', { id: socket.id, username, on: false });
    }
  }

  function leaveVoice(reason = 'não especificado') {
    stopSharing(reason);
    state.muted.delete(socket.id);
    state.deafened.delete(socket.id);
    if (state.voice.has(socket.id)) {
      const dest = toVoice(); // servidor da sala, antes de remover
      state.voice.delete(socket.id);
      console.log(`[voz] saiu: ${username} — motivo: ${reason}`);
      dest.emit('voice-user-left', { id: socket.id });
    }
  }

  on('leave-voice', () => leaveVoice('saiu do canal de voz (botão)'));

  // Relay de sinalização WebRTC: só entre membros do canal de voz.
  // Teto de 32KB: SDP real tem poucos KB; sem isso o relay vira amplificador de banda (300KB/frame)
  on('signal', (payload) => {
    const { to, data } = payload || {};
    if (!loggedIn() || typeof to !== 'string' || !data || typeof data !== 'object') return;
    if (JSON.stringify(data).length > 32 * 1024) return;
    const room = state.voice.get(socket.id);
    if (!room || state.voice.get(to) !== room) return; // só relaya dentro da mesma sala
    io.to(to).emit('signal', { from: socket.id, data });
  });

  on('screen-share', (payload) => {
    if (!loggedIn() || !state.voice.has(socket.id)) return;
    const on = !!(payload && payload.on);
    if (on) {
      if (!state.sharing.has(socket.id)) {
        shareStart.set(socket.id, Date.now());
        console.log(`[share] início: ${username} (${socket.id}) — ${state.voice.size} na voz, ${state.users.size} online`);
      }
      state.sharing.add(socket.id);
      toVoice().emit('screen-share', { id: socket.id, username, on: true });
    } else {
      // Motivo vem do cliente (botão do app, navegador encerrou a captura, etc.)
      const reason = payload && typeof payload.reason === 'string' ? payload.reason.slice(0, 120) : 'parada pelo usuário';
      stopSharing(reason);
    }
  });

  // Thumbnail periódico da transmissão (prévia antes de assistir)
  on('screen-thumb', (payload) => {
    if (!state.sharing.has(socket.id)) return;
    const img = payload && payload.img;
    if (!validImage(img, MAX_THUMB)) return;
    state.thumbs.set(socket.id, img);
    toVoice().emit('screen-thumb', { id: socket.id, img });
  });

  // Espectador pede/encerra a transmissão de alguém (vídeo só vai para quem assiste)
  on('watch', (payload, ack) => {
    const to = payload && payload.to;
    const room = state.voice.get(socket.id);
    // Só assiste quem transmite na MESMA sala
    const ok = typeof to === 'string' && !!room && state.voice.get(to) === room && state.sharing.has(to);
    if (ok) io.to(to).emit('watch-request', { from: socket.id });
    if (typeof ack === 'function') ack({ ok });
  });

  on('unwatch', (payload) => {
    const to = payload && payload.to;
    if (typeof to !== 'string' || !state.voice.has(to)) return;
    io.to(to).emit('watch-stop', { from: socket.id });
  });

  // socket.io entrega o motivo do disconnect: 'transport close' (rede/aba fechada),
  // 'ping timeout' (cliente sumiu sem avisar), 'server namespace disconnect' (derrubado) etc.
  on('disconnect', (reason) => {
    if (!loggedIn()) return;
    leaveVoice('desconectou: ' + reason);
    // delete pode já ter acontecido via dropStale: só notifica se éramos nós que removemos
    if (state.users.delete(socket.id)) toServer().emit('user-left', { id: socket.id, username });
    state.viewing.delete(socket.id);
  });
});

// Health check: ping externo anti-hibernação vê só {ok}. Métricas (presença, memória) exigem
// o token abaixo (/healthz?token=...) — não vazam presença nem pressão de memória a qualquer um.
const HEALTH_TOKEN = 'hx-metrics'; // valor fixo por enquanto
app.get('/healthz', (req, res) => {
  if (req.query.token !== HEALTH_TOKEN) return res.json({ ok: true });
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

module.exports = { httpServer, io, state, db, authBuckets, connCount };
