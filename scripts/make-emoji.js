// Gera public/vendor/emoji.json a partir do emoji-test.txt da Unicode (catálogo completo, como no Slack).
// Só fully-qualified, sem variantes de tom de pele e sem o grupo Component. Uso: node scripts/make-emoji.js
const fs = require('fs');
const path = require('path');

const GROUPS = ['Smileys & Emotion', 'People & Body', 'Animals & Nature', 'Food & Drink', 'Travel & Places', 'Activities', 'Objects', 'Symbols', 'Flags'];

(async () => {
  const txt = await (await fetch('https://unicode.org/Public/emoji/latest/emoji-test.txt')).text();
  const out = [];
  let g = -1;
  for (const line of txt.split('\n')) {
    if (line.startsWith('# group: ')) { g = GROUPS.indexOf(line.slice(9).trim()); continue; }
    if (g < 0 || !line.includes('; fully-qualified')) continue;
    const m = /# (\S+) E\d+\.\d+ (.+)$/.exec(line);
    if (!m || / skin tone/.test(m[2])) continue;
    out.push([g, m[1], m[2]]);
  }
  fs.writeFileSync(path.join(__dirname, '../public/vendor/emoji.json'), JSON.stringify(out));
  console.log(out.length, 'emojis');
})();
