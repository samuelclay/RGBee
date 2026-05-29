#!/usr/bin/env node
// Syntax-check the inline frontend JS embedded in public/index.html.
// The page ships its app code in the last <script> block; tsc doesn't see it,
// so we extract it and run `node --check` to catch syntax errors before deploy.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const file = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(file, 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!blocks.length) {
  console.error('No inline <script> block found in public/index.html');
  process.exit(1);
}
const code = blocks[blocks.length - 1][1];
const tmp = path.join(os.tmpdir(), 'rgbee_inline_check.js');
fs.writeFileSync(tmp, code);

try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'inherit' });
} catch {
  process.exit(1);
}
console.log(`inline JS OK (${code.length} chars)`);
