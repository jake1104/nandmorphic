import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

function buildId() {
  if (process.env.BUILD_HASH) return String(process.env.BUILD_HASH).slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim().slice(0, 7) || 'dev';
  } catch {
    return 'dev';
  }
}
const BUILD_ID = buildId();

const SRC_DIR = 'js';
const DIST_DIR = 'dist';
const DIST_JS = join(DIST_DIR, 'js');
const DIST_CSS = join(DIST_DIR, 'css');

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 6);
}

rmSync(DIST_DIR, { recursive: true, force: true });
mkdirSync(DIST_JS, { recursive: true });
mkdirSync(DIST_CSS, { recursive: true });

const files = readdirSync(SRC_DIR).filter(f => f.endsWith('.js'));
const contents = {};
const hashes = {};
for (const f of files) {
  contents[f] = readFileSync(join(SRC_DIR, f), 'utf-8');
  hashes[f] = hash(contents[f]);
}

const mapped = {};
for (const f of files) {
  mapped[f] = f.replace('.js', `.${hashes[f]}.js`);
}

for (const f of files) {
  let content = contents[f];
  for (const [orig, hashed] of Object.entries(mapped)) {
    content = content.replaceAll(`'./${orig}'`, `'./${hashed}'`);
    content = content.replaceAll(`"./${orig}"`, `"./${hashed}"`);
  }
  content = content.replaceAll('__BUILD_ID__', BUILD_ID);
  writeFileSync(join(DIST_JS, mapped[f]), content);
}

let html = readFileSync('index.html', 'utf-8');
html = html.replace('css/style.css', `css/style.css`);
html = html.replace(/js\/main\.js\?v=\w+/, `js/${mapped['main.js']}`);
writeFileSync(join(DIST_DIR, 'index.html'), html);

writeFileSync(join(DIST_CSS, 'style.css'), readFileSync('css/style.css', 'utf-8'));

console.log(`Build complete (BUILD ${BUILD_ID}). JS hashes:`);
for (const [f, h] of Object.entries(hashes)) console.log(`  ${f} → ${mapped[f]}`);
