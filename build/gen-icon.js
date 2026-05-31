// One-off helper: generate build/icon.ico (multi-size) from icon.png.
// Run with: node build/gen-icon.js
const _pti = require('png-to-ico');
const pngToIco = typeof _pti === 'function' ? _pti : _pti.default;
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'icon.png');
const out = path.join(__dirname, 'icon.ico');

pngToIco(src)
  .then(buf => {
    fs.writeFileSync(out, buf);
    console.log('Wrote', out, buf.length, 'bytes');
  })
  .catch(err => {
    console.error('Icon generation failed:', err);
    process.exit(1);
  });
