process.env.HX_DB = ':memory:'; // antes do require: DB de teste isolado

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { io: Client } = require('socket.io-client');
const { httpServer, state, db, authBuckets, closeSfu } = require('../server.js');

let url;
const clients = [];

before(async () => {
  await new Promise((resolve) => httpServer.listen(0, resolve));
  url = 'http://localhost:' + httpServer.address().port;
});

after(() => {
  clients.forEach((c) => c.disconnect());
  httpServer.close();
  closeSfu(); // worker do mediasoup é subprocesso: seguraria o event loop para sempre
});

beforeEach(() => {
  clients.splice(0).forEach((c) => c.disconnect());
  state.users.clear();
  state.viewing.clear();
  Object.keys(state.messages).forEach((sv) => { state.messages[sv].length = 0; }); // por servidor
  state.voice.clear();
  state.muted.clear();
  state.deafened.clear();
  state.sharing.clear();
  state.thumbs.clear();
  db.exec('DELETE FROM users'); db.exec('DELETE FROM sessions'); db.exec('DELETE FROM messages');
  authBuckets.clear(); // não deixar o rate limit de auth por IP vazar entre testes
});

function connect() {
  const c = Client(url, { forceNew: true, transports: ['websocket'] });
  clients.push(c);
  return new Promise((resolve) => c.on('connect', () => resolve(c)));
}

function emitAck(client, event, payload) {
  return new Promise((resolve) => client.emit(event, payload, resolve));
}

async function loggedClient(username, password = 'senha123') {
  const c = await connect();
  const res = await emitAck(c, 'register', { username, password });
  assert.equal(res.ok, true, 'registro deveria funcionar: ' + JSON.stringify(res));
  return c;
}

function once(client, event) {
  return new Promise((resolve) => client.once(event, resolve));
}

function joinVoice(client, room = 'akon') {
  return new Promise((resolve) => client.emit('join-voice', { room }, resolve));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Auth ----------

test('register cria conta e entra no servidor HX', async () => {
  const c = await connect();
  const res = await emitAck(c, 'register', { username: 'ana', password: 'senha123' });
  assert.equal(res.ok, true);
  assert.equal(res.server, 'hx');
  assert.equal(res.serverName, 'HX');
  assert.ok(Array.isArray(res.servers) && res.servers.length === 3, 'três servidores no ack');
  assert.equal(res.selfId, c.id);
  assert.deepEqual(res.messages, []);
  assert.deepEqual(res.sharers, []);
});

test('register rejeita duplicado (inclusive outra caixa) e credenciais fracas', async () => {
  const a = await connect();
  await emitAck(a, 'register', { username: 'ana', password: 'senha123' });

  const b = await connect();
  assert.ok((await emitAck(b, 'register', { username: 'ana', password: 'outra123' })).error, 'duplicado');
  assert.ok((await emitAck(b, 'register', { username: 'ANA', password: 'outra123' })).error, 'duplicado com caixa diferente');
  assert.ok((await emitAck(b, 'register', { username: 'ab', password: 'senha123' })).error, 'usuário curto');
  assert.ok((await emitAck(b, 'register', { username: 'beto', password: '12345' })).error, 'senha curta');
  assert.ok((await emitAck(b, 'register', null)).error, 'payload nulo');
  assert.ok((await emitAck(b, 'register', { username: 5, password: 'senha123' })).error, 'tipos errados');
});

test('login valida senha; mensagens de erro não revelam se o usuário existe', async () => {
  const a = await connect();
  await emitAck(a, 'register', { username: 'ana', password: 'senha123' });
  a.disconnect();

  const b = await connect();
  const wrongPass = await emitAck(b, 'login', { username: 'ana', password: 'errada99' });
  const noUser = await emitAck(b, 'login', { username: 'ninguem', password: 'senha123' });
  assert.ok(wrongPass.error && noUser.error);
  assert.equal(wrongPass.error, noUser.error, 'mesma mensagem para senha errada e usuário inexistente');

  const ok = await emitAck(b, 'login', { username: 'ana', password: 'senha123' });
  assert.equal(ok.ok, true);
});

test('senha nunca é armazenada em texto puro (hash + salt por usuário)', async () => {
  const a = await connect();
  await emitAck(a, 'register', { username: 'ana', password: 'minhaSenhaSecreta' });
  const b = await connect();
  await emitAck(b, 'register', { username: 'beto', password: 'minhaSenhaSecreta' });

  const rows = db.prepare('SELECT username, salt, hash FROM users ORDER BY username').all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.notEqual(row.hash, 'minhaSenhaSecreta');
    assert.ok(!row.hash.includes('minhaSenhaSecreta'), 'hash não contém a senha');
    assert.match(row.hash, /^s2\$\d+\$\d+\$\d+\$[0-9a-f]{128}$/, 'hash scrypt versionado com parâmetros');
    assert.match(row.salt, /^[0-9a-f]{32}$/, 'salt de 16 bytes em hex');
  }
  assert.notEqual(rows[0].hash, rows[1].hash, 'mesma senha, hashes diferentes (salt único)');
});

test('senha antiga (hash sem parâmetros) ainda entra e migra para o formato novo', async () => {
  const crypto = require('node:crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  const legacy = crypto.scryptSync('senha123', Buffer.from(salt, 'hex'), 64,
    { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString('hex');
  db.prepare('INSERT INTO users (username, salt, hash) VALUES (?, ?, ?)').run('antiga', salt, legacy);

  const a = await connect();
  const res = await emitAck(a, 'login', { username: 'antiga', password: 'senha123' });
  assert.equal(res.ok, true, 'conta antiga continua entrando');
  assert.match(db.prepare('SELECT hash FROM users WHERE username = ?').get('antiga').hash, /^s2\$/, 'migrou');

  a.disconnect();
  const b = await connect();
  assert.equal((await emitAck(b, 'login', { username: 'antiga', password: 'senha123' })).ok, true, 'entra após migrar');
  assert.ok((await emitAck(b, 'login', { username: 'antiga', password: 'errada99' })).error);
});

test('login duplicado na mesma conexão responde erro', async () => {
  const a = await loggedClient('ana');
  const again = await emitAck(a, 'register', { username: 'beto', password: 'senha123' });
  assert.ok(again.error);
});

test('login com caixa diferente devolve o nome canônico do banco', async () => {
  const a = await connect();
  await emitAck(a, 'register', { username: 'ana', password: 'senha123' });
  a.disconnect();
  const b = await connect();
  const res = await emitAck(b, 'login', { username: 'ANA', password: 'senha123' });
  assert.equal(res.ok, true);
  assert.equal(res.username, 'ana');
});

test('watch responde ack: ok=true quando transmite, ok=false quando não', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  await joinVoice(a);
  await joinVoice(b);

  const nack = await emitAck(b, 'watch', { to: a.id }); // a não transmite
  assert.equal(nack.ok, false);

  a.emit('screen-share', { on: true });
  await sleep(50);
  const req = once(a, 'watch-request');
  const ok = await emitAck(b, 'watch', { to: a.id });
  assert.equal(ok.ok, true);
  assert.equal((await req).from, b.id);
});

test('sfu: caps respondem e transporte é criado para quem está logado', async () => {
  const a = await loggedClient('ana');
  // worker do mediasoup sobe assíncrono: espera ficar pronto (ou desiste e o teste cobre o fallback)
  let caps = null;
  for (let i = 0; i < 20 && !caps; i++) {
    const res = await emitAck(a, 'sfu-caps', {});
    if (res && res.ok) caps = res.rtpCapabilities;
    else await sleep(100);
  }
  if (!caps) return; // ambiente sem mediasoup: fallback P2P é o comportamento esperado
  assert.ok(Array.isArray(caps.codecs) && caps.codecs.length > 0, 'router publica codecs');
  const t = await emitAck(a, 'sfu-create-transport', { dir: 'recv' });
  assert.equal(t.ok, true, 'transporte deveria ser criado: ' + JSON.stringify(t));
  assert.ok(t.iceParameters && t.dtlsParameters, 'parâmetros ICE/DTLS presentes');
  const semLogin = await connect();
  assert.ok((await emitAck(semLogin, 'sfu-create-transport', { dir: 'recv' })).error, 'sem login falha');
});

test('watchers: plateia propaga ao assistir, parar e sair da voz', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  await joinVoice(a);
  await joinVoice(b);
  a.emit('screen-share', { on: true });
  await sleep(50);

  let w = once(a, 'watchers');
  await emitAck(b, 'watch', { to: a.id });
  let ev = await w;
  assert.equal(ev.id, a.id);
  assert.deepEqual(ev.names, ['beto']);

  w = once(a, 'watchers');
  b.emit('unwatch', { to: a.id });
  ev = await w;
  assert.deepEqual(ev.names, []);

  w = once(a, 'watchers');
  await emitAck(b, 'watch', { to: a.id });
  assert.deepEqual((await w).names, ['beto']);

  w = once(a, 'watchers');
  b.emit('leave-voice');
  assert.deepEqual((await w).names, []); // sair da voz também sai da plateia
});

test('set-avatar: salva no banco, propaga e chega no login de quem entra depois', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');

  const semLogin = await connect();
  assert.ok((await emitAck(semLogin, 'set-avatar', { img: 'data:image/jpeg;base64,AAAA' })).error, 'sem login falha');
  assert.ok((await emitAck(a, 'set-avatar', { img: 'data:text/html;base64,x' })).error, 'formato inválido falha');
  assert.ok((await emitAck(a, 'set-avatar', { img: 'data:image/jpeg;base64,' + 'A'.repeat(150 * 1024) })).error, 'grande demais falha');

  const changed = once(b, 'avatar-changed');
  const ok = await emitAck(a, 'set-avatar', { img: 'data:image/jpeg;base64,AAAA' });
  assert.equal(ok.ok, true);
  const ev = await changed;
  assert.equal(ev.username, 'ana');
  assert.equal(ev.avatar, 'data:image/jpeg;base64,AAAA');
  assert.equal(db.prepare('SELECT avatar FROM users WHERE username = ?').get('ana').avatar, 'data:image/jpeg;base64,AAAA');

  const c = await connect();
  const rc = await emitAck(c, 'register', { username: 'carla', password: 'senha123' });
  assert.equal(rc.avatars.ana, 'data:image/jpeg;base64,AAAA');
});

test('set-avatar null remove a foto do banco e propaga', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  const first = once(b, 'avatar-changed');
  await emitAck(a, 'set-avatar', { img: 'data:image/jpeg;base64,AAAA' });
  await first; // consome o broadcast do set antes de esperar o do remove

  const changed = once(b, 'avatar-changed');
  const ok = await emitAck(a, 'set-avatar', { img: null });
  assert.equal(ok.ok, true);
  assert.equal((await changed).avatar, null);
  assert.equal(db.prepare('SELECT avatar FROM users WHERE username = ?').get('ana').avatar, null);
});

test('rename: atualiza banco e estado, propaga, rejeita duplicado e inválido', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');

  assert.ok((await emitAck(a, 'rename', { username: 'beto' })).error, 'nome já usado');
  assert.ok((await emitAck(a, 'rename', { username: 'ab' })).error, 'curto demais');
  const semLogin = await connect();
  assert.ok((await emitAck(semLogin, 'rename', { username: 'novo' })).error, 'sem login');

  const notice = once(b, 'user-renamed');
  const ok = await emitAck(a, 'rename', { username: 'anastacia' });
  assert.equal(ok.ok, true);
  assert.equal(ok.username, 'anastacia');
  const ev = await notice;
  assert.equal(ev.id, a.id);
  assert.equal(ev.oldName, 'ana');
  assert.equal(ev.newName, 'anastacia');
  assert.ok(db.prepare('SELECT 1 FROM users WHERE username = ?').get('anastacia'));
  assert.equal(db.prepare('SELECT 1 FROM users WHERE username = ?').get('ana'), undefined);
  assert.equal(state.users.get(a.id), 'anastacia');

  // mensagens novas saem com o nome novo
  const got = once(b, 'chat-message');
  a.emit('chat-message', { text: 'oi' });
  assert.equal((await got).username, 'anastacia');
});

test('sessão: token do login permite voltar sem senha e sobrevive a "restart"', async () => {
  const a = await connect();
  const reg = await emitAck(a, 'register', { username: 'ana', password: 'senha123' });
  assert.match(reg.token, /^[0-9a-f]{64}$/, 'token entregue no registro');
  a.disconnect();

  // outro socket (equivale a reconectar depois de o servidor cair)
  const b = await connect();
  const res = await emitAck(b, 'resume', { token: reg.token });
  assert.equal(res.ok, true);
  assert.equal(res.username, 'ana');
  assert.match(res.token, /^[0-9a-f]{64}$/, 'resume entrega um token');
  assert.notEqual(res.token, reg.token, 'token é rotacionado no resume');
  b.disconnect();

  // token antigo não vale mais depois de rotacionado; o novo vale
  const b2 = await connect();
  assert.ok((await emitAck(b2, 'resume', { token: reg.token })).error, 'token antigo revogado após rotação');
  const b3 = await connect();
  assert.equal((await emitAck(b3, 'resume', { token: res.token })).ok, true, 'token rotacionado funciona');

  const c = await connect();
  assert.ok((await emitAck(c, 'resume', { token: 'x'.repeat(64) })).error, 'token inválido');
  assert.ok((await emitAck(c, 'resume', null)).error, 'payload inválido');
});

test('sessão: token guardado em hash, não em texto puro', async () => {
  const a = await connect();
  const reg = await emitAck(a, 'register', { username: 'ana', password: 'senha123' });
  const rows = db.prepare('SELECT token FROM sessions').all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token, reg.token);
  assert.match(rows[0].token, /^[0-9a-f]{64}$/);
});

test('logout invalida a sessão', async () => {
  const a = await connect();
  const reg = await emitAck(a, 'register', { username: 'ana', password: 'senha123' });
  a.emit('logout', { token: reg.token });
  await sleep(80);
  const b = await connect();
  assert.ok((await emitAck(b, 'resume', { token: reg.token })).error);
});

test('rename mantém a sessão válida', async () => {
  const a = await connect();
  const reg = await emitAck(a, 'register', { username: 'ana', password: 'senha123' });
  await emitAck(a, 'rename', { username: 'anastacia' });
  a.disconnect();
  const b = await connect();
  const res = await emitAck(b, 'resume', { token: reg.token });
  assert.equal(res.username, 'anastacia');
});

test('login com senha revoga os tokens antigos (desconectar outros dispositivos)', async () => {
  const a = await connect();
  const reg = await emitAck(a, 'register', { username: 'ana', password: 'senha123' });
  a.disconnect();
  await sleep(80);

  const b = await connect();
  assert.equal((await emitAck(b, 'login', { username: 'ana', password: 'senha123' })).ok, true);
  b.disconnect();
  await sleep(80);

  const c = await connect();
  assert.ok((await emitAck(c, 'resume', { token: reg.token })).error, 'token antigo morreu no login com senha');
});

test('rate limit de auth por IP sobrevive à reconexão (fura o bucket por-socket)', async () => {
  // Reconecta a cada tentativa: cada socket novo tem bucket próprio zerado, então só o limite
  // POR IP (que persiste) pode travar. É exatamente o exploit que o bucket por-socket não pegava.
  let blocked = false;
  for (let i = 0; i < 40 && !blocked; i++) {
    const c = await connect();
    const r = await emitAck(c, 'login', { username: 'ninguem' + i, password: 'senha123' });
    if (/Muitas tentativas/.test(r.error || '')) blocked = true; // mensagem específica do authAllow
    c.disconnect();
  }
  assert.ok(blocked, 'o limite por IP deveria travar mesmo reconectando a cada tentativa');
});

test('charset do nome: caracteres especiais liberados; invisíveis/controle barrados', async () => {
  const a = await connect();
  assert.ok((await emitAck(a, 'register', { username: 'a\u200bna', password: 'senha123' })).error, 'zero-width barrado');
  assert.ok((await emitAck(a, 'register', { username: 'ana\nx', password: 'senha123' })).error, 'newline barrado');
  assert.ok((await emitAck(a, 'register', { username: 'a\u202ena', password: 'senha123' })).error, 'override bidi barrado');
  const d = await connect(); // socket novo: 'a' já gastou o bucket por-socket com 3 registers
  assert.equal((await emitAck(d, 'register', { username: 'joão_2', password: 'senha123' })).ok, true, 'acento/underscore ok');
  const b = await connect();
  assert.equal((await emitAck(b, 'register', { username: 'zé★!#', password: 'senha123' })).ok, true, 'símbolos/estrela liberados');
  const c = await connect();
  assert.equal((await emitAck(c, 'register', { username: 'lud 🐍', password: 'senha123' })).ok, true, 'emoji liberado');
});

test('voice-roster: lista quem está em chamada num servidor, com mute/deafen', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  await joinVoice(a, 'akon');
  await joinVoice(b, 'tibia');
  a.emit('set-muted', { muted: true });
  await sleep(40);

  const res = await emitAck(b, 'voice-roster', { server: 'hx' });
  assert.equal(res.ok, true);
  assert.equal(res.users.length, 2, 'ana e beto na voz do hx');
  const ra = res.users.find((u) => u.id === a.id);
  assert.equal(ra.room, 'akon');
  assert.equal(ra.muted, true, 'ana aparece mutada');

  const vazio = await emitAck(b, 'voice-roster', { server: 'panteras' });
  assert.equal(vazio.users.length, 0, 'ninguém na voz do panteras');
  assert.ok((await emitAck(b, 'voice-roster', { server: 'nao-existe' })).error, 'servidor inválido');
});

test('get-profile: devolve data de cadastro; exige login; nome inexistente falha', async () => {
  const a = await loggedClient('ana');
  const semLogin = await connect();
  assert.ok((await emitAck(semLogin, 'get-profile', { username: 'ana' })).error, 'sem login falha');
  assert.ok((await emitAck(a, 'get-profile', { username: 'ninguem' })).error, 'inexistente falha');

  const res = await emitAck(a, 'get-profile', { username: 'ana' });
  assert.equal(res.ok, true);
  assert.equal(res.username, 'ana');
  assert.ok(Number.isInteger(res.created) && res.created > 0, 'created veio do registro');
});

test('headers de segurança presentes nas respostas HTTP', async () => {
  const res = await fetch(url + '/healthz');
  assert.ok(res.headers.get('content-security-policy').includes("default-src 'self'"));
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('erro em um handler não derruba o servidor', async () => {
  const a = await loggedClient('ana');
  a.emit('set-avatar', { img: { toString() { throw new Error('boom'); } } });
  a.emit('rename', { username: Object.create(null) });
  await sleep(120);
  const b = await connect();
  assert.equal((await emitAck(b, 'register', { username: 'beto', password: 'senha123' })).ok, true);
});

// ---------- Chat ----------

test('chat: broadcast para todos e histórico para quem chega depois', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');

  const gotA = once(a, 'chat-message');
  const gotB = once(b, 'chat-message');
  a.emit('chat-message', { text: 'olá!' });
  const [ma, mb] = await Promise.all([gotA, gotB]);
  assert.equal(ma.text, 'olá!');
  assert.equal(ma.username, 'ana');
  assert.deepEqual(ma, mb);

  const c = await loggedClient('carla');
  const rc = await emitAck(c, 'login', {}); // já logado — só para sincronizar
  const d = await connect();
  const rd = await emitAck(d, 'register', { username: 'dani', password: 'senha123' });
  assert.equal(rd.messages.length, 1);
  assert.equal(rd.messages[0].text, 'olá!');
});

test('chat: mensagem vazia ou sem login é ignorada', async () => {
  const a = await loggedClient('ana');
  const intruso = await connect();
  a.emit('chat-message', { text: '   ' });
  a.emit('chat-message', null);
  intruso.emit('chat-message', { text: 'invasor' });
  await sleep(100);
  assert.equal(state.messages.hx.length, 0);
});

test('chat: mensagem persiste no banco (histórico sobrevive a restart)', async () => {
  const a = await loggedClient('ana');
  const gotA = once(a, 'chat-message');
  a.emit('chat-message', { text: 'persistente' });
  await gotA;
  const rows = db.prepare('SELECT username, text FROM messages').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].username, 'ana');
  assert.equal(rows[0].text, 'persistente');
});

test('editar/apagar mensagem: só o autor consegue; propaga e atualiza banco/estado', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');

  const got = once(b, 'chat-message');
  a.emit('chat-message', { text: 'original' });
  const msg = await got;
  assert.ok(Number.isInteger(msg.id), 'mensagem carrega id');

  assert.ok((await emitAck(b, 'edit-message', { id: msg.id, text: 'hackeada' })).error, 'editar de outro falha');
  assert.ok((await emitAck(b, 'delete-message', { id: msg.id })).error, 'apagar de outro falha');

  const edited = once(b, 'message-edited');
  assert.equal((await emitAck(a, 'edit-message', { id: msg.id, text: 'corrigida' })).ok, true);
  const ev = await edited;
  assert.equal(ev.id, msg.id);
  assert.equal(ev.text, 'corrigida');
  assert.equal(db.prepare('SELECT text, edited FROM messages WHERE id = ?').get(msg.id).text, 'corrigida');
  assert.equal(state.messages.hx.find((m) => m.id === msg.id).text, 'corrigida');

  const deleted = once(b, 'message-deleted');
  assert.equal((await emitAck(a, 'delete-message', { id: msg.id })).ok, true);
  assert.equal((await deleted).id, msg.id);
  assert.equal(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(msg.id), undefined);
  assert.ok(!state.messages.hx.some((m) => m.id === msg.id));
});

test('chat com imagem: válida propaga e persiste; inválida é descartada', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');

  const got = once(b, 'chat-message');
  a.emit('chat-message', { text: '', img: 'data:image/jpeg;base64,AAAA' });
  const msg = await got;
  assert.equal(msg.img, 'data:image/jpeg;base64,AAAA');
  assert.equal(db.prepare('SELECT img FROM messages WHERE id = ?').get(msg.id).img, 'data:image/jpeg;base64,AAAA');

  a.emit('chat-message', { text: '', img: 'data:text/html;base64,x' });
  a.emit('chat-message', { text: '', img: 'data:image/jpeg;base64,inválido!!!' });
  await sleep(100);
  assert.equal(state.messages.hx.length, 1, 'imagem inválida não entra');
});

test('login ack traz allUsers (inclusive offline) e user-joined carrega avatar', async () => {
  const a = await loggedClient('ana');
  await emitAck(a, 'set-avatar', { img: 'data:image/jpeg;base64,AAAA' });
  a.disconnect();
  await sleep(80);

  const b = await loggedClient('beto');
  const rejoined = once(b, 'user-joined');
  const a2 = await connect();
  const res = await emitAck(a2, 'login', { username: 'ana', password: 'senha123' });
  assert.ok(res.allUsers.includes('ana') && res.allUsers.includes('beto'), 'todos os registrados no ack');
  assert.equal((await rejoined).avatar, 'data:image/jpeg;base64,AAAA', 'quem entra chega com a própria foto');
});

test('signal: payload gigante é descartado', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  await joinVoice(a);
  await joinVoice(b);

  let leaked = false;
  b.on('signal', () => { leaked = true; });
  a.emit('signal', { to: b.id, data: { blob: 'x'.repeat(64 * 1024) } });
  await sleep(100);
  assert.equal(leaked, false, 'sinal de 64KB não pode ser retransmitido');

  const got = once(b, 'signal');
  a.emit('signal', { to: b.id, data: { description: { type: 'offer', sdp: 'x' } } });
  assert.equal((await got).from, a.id, 'sinal normal segue passando');
});

test('typing: retransmite para os outros, não para quem digita nem sem login', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  const semLogin = await connect();

  let selfEcho = false;
  a.on('typing', () => { selfEcho = true; });
  const got = once(b, 'typing');
  a.emit('typing');
  assert.equal((await got).username, 'ana');
  assert.equal(selfEcho, false);

  let leaked = false;
  b.on('typing', () => { leaked = true; });
  semLogin.emit('typing');
  await sleep(80);
  assert.equal(leaked, false);
});

test('ping-hx: servidor devolve o ack para o cliente medir a latência', async () => {
  const a = await loggedClient('ana');
  const acked = await new Promise((resolve) => {
    const t0 = Date.now();
    a.emit('ping-hx', () => resolve(Date.now() - t0));
  });
  assert.ok(acked >= 0 && acked < 4000, 'ack voltou dentro de um tempo razoável');
});

test('anti-flood: rajada de chat esbarra no limite; eventos seguem funcionando depois', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  let received = 0;
  b.on('chat-message', () => { received++; });
  for (let i = 0; i < 60; i++) a.emit('chat-message', { text: 'flood ' + i });
  await sleep(300);
  assert.ok(received < 60, 'rajada deveria ser cortada, chegou tudo: ' + received);
  assert.ok(received >= 10, 'limite não pode engolir o uso normal: ' + received);
});

test('conexão nova da mesma conta substitui a antiga (sem fantasma na lista)', async () => {
  const a = await connect();
  const reg = await emitAck(a, 'register', { username: 'ana', password: 'senha123' });
  await joinVoice(a);
  const oldId = a.id;

  const watcher = await loggedClient('beto');
  const superseded = once(a, 'session-superseded');
  const left = once(watcher, 'user-left');

  const b = await connect();
  const res = await emitAck(b, 'resume', { token: reg.token });
  assert.equal(res.ok, true);
  await superseded;
  assert.equal((await left).id, oldId, 'todos sabem que a conexão antiga saiu');
  assert.equal(state.users.has(oldId), false, 'estado antigo limpo na hora');
  assert.equal(state.voice.has(oldId), false, 'voz limpa também');
  assert.ok(!res.users.some((u) => u.id === oldId), 'lista entregue já vem sem o fantasma');
});

// ---------- Voz ----------

test('voz: join-voice retorna peers existentes e notifica', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');

  const ra = await joinVoice(a);
  assert.deepEqual(ra.peers, []);

  const noticeA = once(a, 'voice-user-joined');
  const rb = await joinVoice(b);
  assert.equal(rb.peers.length, 1);
  assert.equal(rb.peers[0].id, a.id);
  assert.equal(rb.peers[0].username, 'ana');
  assert.equal((await noticeA).id, b.id);
});

test('join-voice idempotente: sem self nos peers, sem re-broadcast; sem login responde erro', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  await joinVoice(a);
  const r2 = await joinVoice(a);
  assert.ok(!r2.peers.some((p) => p.id === a.id));

  let rebroadcasts = 0;
  b.on('voice-user-joined', () => { rebroadcasts++; });
  await joinVoice(a);
  await sleep(100);
  assert.equal(rebroadcasts, 0);

  const semLogin = await connect();
  assert.ok((await joinVoice(semLogin)).error);
});

test('salas de voz: peers e sinalização isolados por sala; sala inválida recusada', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  const c = await loggedClient('carla');

  assert.ok((await joinVoice(a, 'inexistente')).error, 'sala inválida recusada');

  const ra = await joinVoice(a, 'akon');
  const rb = await joinVoice(b, 'tibia');
  assert.deepEqual(ra.peers, [], 'akon vazia para ana');
  assert.deepEqual(rb.peers, [], 'beto não vê ana (outra sala)');

  const rc = await joinVoice(c, 'akon');
  assert.equal(rc.peers.length, 1, 'carla vê só ana na akon');
  assert.equal(rc.peers[0].id, a.id);

  // sinal entre salas diferentes é bloqueado; dentro da mesma sala passa
  let leaked = false;
  b.on('signal', () => { leaked = true; });
  a.emit('signal', { to: b.id, data: { description: { type: 'offer', sdp: 'x' } } });
  const gotC = once(c, 'signal');
  a.emit('signal', { to: c.id, data: { description: { type: 'offer', sdp: 'y' } } });
  assert.equal((await gotC).from, a.id, 'sinal na mesma sala passa');
  await sleep(80);
  assert.equal(leaked, false, 'sinal para outra sala é bloqueado');

  // trocar de sala: ana vai para tibia, sai da akon
  const left = once(c, 'voice-user-left');
  const moved = await joinVoice(a, 'tibia');
  assert.equal((await left).id, a.id, 'quem ficou na akon vê ana sair');
  assert.ok(moved.peers.some((p) => p.id === b.id), 'ana agora vê beto na tibia');
});

test('servidores: trocar isola chat/membros e valida salas por servidor', async () => {
  const a = await loggedClient('ana');   // entra no hx (padrão)
  const b = await loggedClient('beto');

  const gotHx = once(b, 'chat-message');
  a.emit('chat-message', { text: 'oi hx' });
  await gotHx;

  const pan = await emitAck(a, 'switch-server', { server: 'panteras' });
  assert.equal(pan.ok, true);
  assert.equal(pan.server, 'panteras');
  assert.equal(pan.serverName, 'Panteras');
  assert.equal(pan.messages.length, 0, 'panteras começa vazio');
  assert.equal(pan.voiceRooms.length, 3, 'panteras tem 3 salas');

  assert.ok((await emitAck(a, 'switch-server', { server: 'nao-existe' })).error, 'servidor inválido recusado');

  // msg em panteras NÃO vaza para quem está no hx
  let leaked = false;
  b.on('chat-message', () => { leaked = true; });
  const c = await loggedClient('carla');
  await emitAck(c, 'switch-server', { server: 'panteras' });
  const gotC = once(c, 'chat-message');
  a.emit('chat-message', { text: 'oi panteras' });
  await gotC;
  await sleep(80);
  assert.equal(leaked, false, 'hx não recebe msg de panteras');

  // histórico isolado por servidor
  const backHx = await emitAck(a, 'switch-server', { server: 'hx' });
  assert.ok(backHx.messages.some((m) => m.text === 'oi hx'), 'hx manteve sua msg');
  assert.ok(!backHx.messages.some((m) => m.text === 'oi panteras'), 'hx não tem msg de panteras');

  // sala precisa ser do servidor que estou vendo
  assert.ok((await joinVoice(a, 'pan-1')).error, 'sala de panteras estando no hx falha');
  assert.equal((await joinVoice(a, 'akon')).room, 'akon', 'sala do hx funciona');
});

test('voz persiste ao trocar de servidor (não cai da call ao navegar)', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  await joinVoice(a, 'akon');  // ana entra na voz do hx
  await joinVoice(b, 'akon');  // beto também

  // ana troca de VIEW para panteras, mas continua na voz do hx
  const pan = await emitAck(a, 'switch-server', { server: 'panteras' });
  assert.equal(pan.ok, true);
  assert.equal(state.voice.get(a.id), 'akon', 'ana continua na sala de voz akon');

  // quem entra no hx ainda vê ana na voz do akon
  const c = await connect();
  const rc = await emitAck(c, 'register', { username: 'carla', password: 'senha123' });
  const voz = rc.voiceUsers.find((u) => u.id === a.id);
  assert.ok(voz && voz.room === 'akon', 'ana aparece na voz do hx mesmo vendo panteras');

  // mutar enquanto vê panteras propaga para o servidor da SALA (hx), não para panteras
  const gotB = once(b, 'user-muted'); // b está no hx
  a.emit('set-muted', { muted: true });
  const ev = await gotB;
  assert.equal(ev.id, a.id);
  assert.equal(ev.muted, true);
});

test('sinalização: relay só entre membros do canal de voz', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  const c = await loggedClient('carla');
  await joinVoice(a);
  await joinVoice(b);
  // c NÃO está na voz

  const gotB = once(b, 'signal');
  a.emit('signal', { to: b.id, data: { description: { type: 'offer', sdp: 'x' } } });
  const sig = await gotB;
  assert.equal(sig.from, a.id);

  let leaked = false;
  b.on('signal', () => { leaked = true; });
  c.on('signal', () => { leaked = true; });
  c.emit('signal', { to: b.id, data: {} });
  a.emit('signal', { to: c.id, data: {} });
  await sleep(100);
  assert.equal(leaked, false);
});

test('set-muted: propaga aos demais, entra no login ack e limpa ao sair da voz', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  await joinVoice(a);

  let leaked = false;
  a.on('user-muted', () => { leaked = true; });
  b.emit('set-muted', { muted: true }); // b não está na voz
  await sleep(80);
  assert.equal(leaked, false);

  const got = once(b, 'user-muted');
  a.emit('set-muted', { muted: true });
  const ev = await got;
  assert.equal(ev.id, a.id);
  assert.equal(ev.muted, true);

  const c = await connect();
  const rc = await emitAck(c, 'register', { username: 'carla', password: 'senha123' });
  assert.equal(rc.voiceUsers.find((u) => u.id === a.id).muted, true);

  a.emit('leave-voice');
  await sleep(80);
  assert.equal(state.muted.size, 0, 'sair da voz limpa o mute');
});

test('set-deafened: propaga aos demais, entra no login ack e limpa ao sair da voz', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  await joinVoice(a);

  let leaked = false;
  a.on('user-deafened', () => { leaked = true; });
  b.emit('set-deafened', { deafened: true }); // b não está na voz
  await sleep(80);
  assert.equal(leaked, false);

  const got = once(b, 'user-deafened');
  a.emit('set-deafened', { deafened: true });
  const ev = await got;
  assert.equal(ev.id, a.id);
  assert.equal(ev.deafened, true);

  const c = await connect();
  const rc = await emitAck(c, 'register', { username: 'carla', password: 'senha123' });
  assert.equal(rc.voiceUsers.find((u) => u.id === a.id).deafened, true);

  a.emit('leave-voice');
  await sleep(80);
  assert.equal(state.deafened.size, 0, 'sair da voz limpa o silenciado');
});

test('disconnect: limpa usuário, voz e transmissão', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  await joinVoice(a);
  a.emit('screen-share', { on: true });
  await sleep(50);
  assert.ok(state.sharing.has(a.id));

  const leftVoice = once(b, 'voice-user-left');
  const leftServer = once(b, 'user-left');
  const shareOff = once(b, 'screen-share');
  a.disconnect();
  const [lv, ls, so] = await Promise.all([leftVoice, leftServer, shareOff]);
  assert.equal(lv.id, ls.id);
  assert.equal(ls.username, 'ana');
  assert.equal(so.on, false);
  assert.equal(state.sharing.size, 0);
  assert.equal(state.thumbs.size, 0);
});

// ---------- Transmissão de tela ----------

test('screen-share: broadcast só de quem está na voz; estado entregue no login', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');

  let early = false;
  b.on('screen-share', () => { early = true; });
  a.emit('screen-share', { on: true }); // a ainda não está na voz
  await sleep(100);
  assert.equal(early, false);

  await joinVoice(a);
  const got = once(b, 'screen-share');
  a.emit('screen-share', { on: true });
  const s = await got;
  assert.equal(s.id, a.id);
  assert.equal(s.on, true);
  assert.equal(s.username, 'ana');

  const c = await connect();
  const rc = await emitAck(c, 'register', { username: 'carla', password: 'senha123' });
  assert.equal(rc.sharers.length, 1);
  assert.equal(rc.sharers[0].id, a.id);
});

test('screen-thumb: relay só de quem transmite, valida formato e tamanho', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  await joinVoice(a);

  let leaked = false;
  b.on('screen-thumb', () => { leaked = true; });
  a.emit('screen-thumb', { img: 'data:image/jpeg;base64,AAAA' }); // ainda não transmite
  await sleep(80);
  assert.equal(leaked, false);

  a.emit('screen-share', { on: true });
  await sleep(50);
  a.emit('screen-thumb', { img: 'data:text/html;base64,PGI+' }); // formato errado
  a.emit('screen-thumb', { img: 'data:image/jpeg;base64,' + 'A'.repeat(250 * 1024) }); // grande demais
  a.emit('screen-thumb', null);
  await sleep(80);
  assert.equal(leaked, false);

  const got = once(b, 'screen-thumb');
  a.emit('screen-thumb', { img: 'data:image/jpeg;base64,AAAA' });
  const t = await got;
  assert.equal(t.id, a.id);
  assert.equal(t.img, 'data:image/jpeg;base64,AAAA');

  // quem chega depois recebe o último thumb no login
  const c = await connect();
  const rc = await emitAck(c, 'register', { username: 'carla', password: 'senha123' });
  assert.equal(rc.sharers[0].thumb, 'data:image/jpeg;base64,AAAA');
});

test('watch/unwatch: relay para o transmissor; watch exige voz e transmissão ativa', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  const c = await loggedClient('carla');
  await joinVoice(a);
  await joinVoice(b);
  a.emit('screen-share', { on: true });
  await sleep(50);

  const req = once(a, 'watch-request');
  b.emit('watch', { to: a.id });
  assert.equal((await req).from, b.id);

  const stop = once(a, 'watch-stop');
  b.emit('unwatch', { to: a.id });
  assert.equal((await stop).from, b.id);

  let leaked = false;
  a.on('watch-request', () => { leaked = true; });
  b.on('watch-request', () => { leaked = true; });
  c.emit('watch', { to: a.id });      // c fora da voz
  b.emit('watch', { to: b.id });      // b não transmite
  b.emit('watch', null);
  await sleep(100);
  assert.equal(leaked, false);
});

// ---------- Robustez ----------

test('payloads null/malformados não derrubam o servidor', async () => {
  const a = await loggedClient('ana');
  await joinVoice(a);
  for (const ev of ['signal', 'screen-share', 'screen-thumb', 'watch', 'unwatch', 'chat-message']) {
    a.emit(ev, null);
    a.emit(ev, 42);
    a.emit(ev, 'x');
  }
  await sleep(100);
  const b = await connect();
  const rb = await emitAck(b, 'register', { username: 'beto', password: 'senha123' });
  assert.equal(rb.ok, true, 'servidor continua respondendo');
});

test('responder: reply carrega autor/trecho da citada; histórico faz JOIN; apagada vira reply só com id', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');

  const got = once(b, 'chat-message');
  a.emit('chat-message', { text: 'pergunta' });
  const orig = await got;

  const gotReply = once(a, 'chat-message');
  b.emit('chat-message', { text: 'resposta', replyTo: orig.id });
  const rep = await gotReply;
  assert.deepEqual(rep.reply, { id: orig.id, username: 'ana', text: 'pergunta' });

  // replyTo inválido (id inexistente / tipo errado) vira mensagem comum
  const gotPlain = once(a, 'chat-message');
  b.emit('chat-message', { text: 'solta', replyTo: 'x' });
  assert.equal((await gotPlain).reply, undefined);

  // Quem chega depois recebe o reply no histórico (JOIN)
  const c = await connect();
  const rc = await emitAck(c, 'register', { username: 'carla', password: 'senha123' });
  assert.deepEqual(rc.messages[1].reply, { id: orig.id, username: 'ana', text: 'pergunta' });

  // Original apagada: histórico ainda referencia, sem autor
  await emitAck(a, 'delete-message', { id: orig.id });
  const d = await connect();
  const rd = await emitAck(d, 'register', { username: 'dani', password: 'senha123' });
  assert.deepEqual(rd.messages[0].reply, { id: orig.id });
});

test('reações: toggle por usuário, broadcast com lista, histórico carrega, apagar mensagem limpa', async () => {
  const a = await loggedClient('ana');
  const b = await loggedClient('beto');
  const got = once(b, 'chat-message');
  a.emit('chat-message', { text: 'reaja' });
  const msg = await got;

  let ev = once(b, 'message-reacted');
  assert.equal((await emitAck(a, 'react', { id: msg.id, emoji: '👍' })).ok, true);
  assert.deepEqual(await ev, { id: msg.id, emoji: '👍', users: ['ana'] });

  ev = once(a, 'message-reacted');
  await emitAck(b, 'react', { id: msg.id, emoji: '👍' });
  assert.deepEqual((await ev).users, ['ana', 'beto']);
  await emitAck(b, 'react', { id: msg.id, emoji: ':kekw:' });

  // Quem chega vê reactions no histórico (memória) e após restart (banco)
  const c = await connect();
  const rc = await emitAck(c, 'register', { username: 'carla', password: 'senha123' });
  assert.deepEqual(rc.messages[0].reactions, { '👍': ['ana', 'beto'], ':kekw:': ['beto'] });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reactions').get().n, 3);

  // Toggle de novo remove; último a sair apaga o emoji
  ev = once(b, 'message-reacted');
  await emitAck(a, 'react', { id: msg.id, emoji: '👍' });
  assert.deepEqual((await ev).users, ['beto']);
  assert.deepEqual((await emitAck(a, 'react', { id: msg.id, emoji: 'tem espaço' })).error, 'Reação inválida.');
  assert.deepEqual((await emitAck(a, 'react', { id: 9999, emoji: '👍' })).error, 'Mensagem não encontrada.');

  await emitAck(a, 'delete-message', { id: msg.id });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reactions').get().n, 0);
});
