// Prova que conta (username/senha) e avatar são gravados no banco e sobrevivem a um RESTART real
// do processo — dois processos Node distintos compartilhando o mesmo arquivo de banco.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const SERVER = path.resolve(__dirname, '..', 'server.js');

function runClient(dbFile, body) {
  const script = `
    const { httpServer } = require(${JSON.stringify(SERVER)});
    const { io: Client } = require('socket.io-client');
    httpServer.listen(0, async () => {
      try {
        const url = 'http://localhost:' + httpServer.address().port;
        const c = Client(url, { forceNew: true, transports: ['websocket'] });
        await new Promise((r) => c.on('connect', r));
        const ack = (e, p) => new Promise((r) => c.emit(e, p, r));
        ${body}
        process.exit(0);
      } catch (err) { console.error('ERR', err && err.message); process.exit(1); }
    });
  `;
  return spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, HX_DB: dbFile }, cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 20000,
  });
}

test('persistência: conta + avatar são gravados e sobrevivem a restart do processo', () => {
  const dbFile = path.join(os.tmpdir(), 'hx-persist-' + process.pid + '.db');
  const clean = () => ['', '-wal', '-shm'].forEach((s) => { try { fs.unlinkSync(dbFile + s); } catch { /* ok */ } });
  clean();

  // Processo 1: registra e salva avatar, depois morre
  const r1 = runClient(dbFile, `
    const reg = await ack('register', { username: 'persistme', password: 'senha123' });
    if (!reg.ok) { console.error('REGFAIL', JSON.stringify(reg)); process.exit(1); }
    const av = await ack('set-avatar', { img: 'data:image/jpeg;base64,AAAA' });
    if (!av.ok) { console.error('AVFAIL'); process.exit(1); }
    console.log('OK1');
  `);
  assert.match(r1.stdout || '', /OK1/, 'registro + avatar no processo 1: ' + (r1.stdout || '') + (r1.stderr || ''));

  // Processo 2 (restart): login com a conta antiga funciona e o avatar veio do banco
  const r2 = runClient(dbFile, `
    const login = await ack('login', { username: 'persistme', password: 'senha123' });
    if (!login.ok) { console.error('LOGINFAIL', JSON.stringify(login)); process.exit(1); }
    if (login.avatars.persistme !== 'data:image/jpeg;base64,AAAA') { console.error('NOAVATAR'); process.exit(1); }
    const bad = await ack('login', { username: 'persistme', password: 'errada99' });
    if (!bad.error) { console.error('WRONGPASS-ACCEPTED'); process.exit(1); }
    console.log('OK2');
  `);
  assert.match(r2.stdout || '', /OK2/, 'login pós-restart + avatar do banco: ' + (r2.stdout || '') + (r2.stderr || ''));

  clean();
});
