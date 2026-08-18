process.env.HX_DB = ':memory:'; // antes do require: DB de teste isolado

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { io: Client } = require('socket.io-client');
const { httpServer, state, db } = require('../server.js');

let url;
const clients = [];

before(async () => {
  await new Promise((resolve) => httpServer.listen(0, resolve));
  url = 'http://localhost:' + httpServer.address().port;
});

after(() => {
  clients.forEach((c) => c.disconnect());
  httpServer.close();
});

beforeEach(() => {
  clients.splice(0).forEach((c) => c.disconnect());
  state.users.clear();
  state.messages.length = 0;
  state.voice.clear();
  state.sharing.clear();
  state.thumbs.clear();
  db.exec('DELETE FROM users');
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

function joinVoice(client) {
  return new Promise((resolve) => client.emit('join-voice', resolve));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Auth ----------

test('register cria conta e entra no servidor HX', async () => {
  const c = await connect();
  const res = await emitAck(c, 'register', { username: 'ana', password: 'senha123' });
  assert.equal(res.ok, true);
  assert.equal(res.server, 'HX');
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
    assert.match(row.hash, /^[0-9a-f]{128}$/, 'hash scrypt de 64 bytes em hex');
    assert.match(row.salt, /^[0-9a-f]{32}$/, 'salt de 16 bytes em hex');
  }
  assert.notEqual(rows[0].hash, rows[1].hash, 'mesma senha, hashes diferentes (salt único)');
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
  assert.equal(state.messages.length, 0);
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
