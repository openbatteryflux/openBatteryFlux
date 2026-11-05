const fs = require('fs');
const path = process.argv[2];
if (!path) {
  console.error('usage: node inspect-obf.js <frontend/js/file>');
  process.exit(1);
}
const s = fs.readFileSync(path, 'utf8');
const m = s.match(/OBFAccount\s*=\s*[^;]+/);
console.log('file:', path);
console.log('OBFAccount assigned here?', !!m);
if (m) console.log(m[0].slice(0, 200));
