// Build a single self-contained index.html for GitHub Pages.
// Inlines css/style.css and bundles the ES modules reachable from js/main.js
// (tiny bundler: dependency-order concat, import lines stripped, `export` keywords removed).
// No npm dependencies. Run: node build-single.mjs  →  dist-single/index.html
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, basename } from 'path';
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

const ENTRY = join('js', 'main.js');
const OUT_DIR = 'dist-single';

function parseImports(src) {
  const deps = [];
  const re = /import\s+[\s\S]*?\sfrom\s+['"]\.\/([^'"]+)['"]\s*;?/g;
  let m;
  while ((m = re.exec(src)) !== null) deps.push(m[1]);
  return deps;
}

function stripModuleSyntax(src) {
  // Collect `X as Y` aliases before stripping, and re-emit them as consts
  // so bundled output keeps working even if a source file uses aliases.
  const aliases = [];
  const namedRe = /^[ \t]*import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"]\s*;?[ \t]*\r?$/gm;
  let m;
  while ((m = namedRe.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const mm = part.trim().match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (mm) aliases.push(`const ${mm[2]} = ${mm[1]};`);
    }
  }
  // Remove static import statements (incl. multi-line).
  let out = src.replace(/^[ \t]*import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"]\s*;?[ \t]*\r?$/gm, '');
  // `export const|function|class` (incl. `export async function`) → plain declaration.
  out = out.replace(/^([ \t]*)export\s+(?=(?:async\s+)?(?:const|function|class)\b)/gm, '$1');
  if (aliases.length) out += `\n${aliases.join('\n')}\n`;
  return out;
}

const ordered = [];
const visited = new Set();
function visit(file) {
  if (visited.has(file)) return;
  visited.add(file);
  const src = readFileSync(file, 'utf-8');
  for (const dep of parseImports(src)) visit(join('js', basename(dep)));
  ordered.push(file);
}
visit(ENTRY);

let bundle = '';
for (const file of ordered) {
  const body = stripModuleSyntax(readFileSync(file, 'utf-8')).trim();
  bundle += `\n/* ===== ${file} ===== */\n${body}\n`;
}
bundle = bundle.replaceAll('__BUILD_ID__', BUILD_ID);

let html = readFileSync('index.html', 'utf-8');
const css = readFileSync(join('css', 'style.css'), 'utf-8');
html = html.replace(
  /<link\s+rel="stylesheet"\s+href="css\/style\.css"\s*\/>/,
  () => `<style>\n${css}\n</style>`,
);
html = html.replace(
  /<script\s+type="module"\s+src="js\/main\.js[^"]*"><\/script>/,
  () => `<script>\n${bundle}\n</script>`,
);

// Safety check: no module syntax may survive in the bundle.
if (/(^|\n)\s*import\s+.*\sfrom\s+['"]/.test(bundle) || /(^|\n)\s*export\s+(const|function|class|default|\{)/.test(bundle)) {
  console.error('ERROR: unresolved import/export left in bundle');
  process.exit(1);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'index.html'), html);
console.log(`Single-file build OK (BUILD ${BUILD_ID}): ${OUT_DIR}/index.html (${ordered.length} modules: ${ordered.join(', ')})`);
