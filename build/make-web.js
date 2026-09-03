/* Builds the browser version into docs/, which is what GitHub Pages serves.
 *
 *   npm run web
 *
 * src/ stays the single source of truth: this copies it verbatim and only
 * swaps the Electron preload for the browser storage adapter.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, 'docs');

function reset(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function buildHtml() {
  let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

  // Blob URLs are how the browser build serves pasted images.
  html = html.replace(
    "img-src 'self' data: inknote-img:",
    "img-src 'self' data: blob: inknote-img:"
  );

  // The adapter has to define window.api before renderer.js runs.
  html = html.replace(
    '<script src="renderer.js"></script>',
    '<script src="starter.js"></script>\n  <script src="api-web.js"></script>\n  <script src="renderer.js"></script>'
  );

  if (!html.includes('api-web.js')) {
    throw new Error('Could not inject the web adapter — did index.html change?');
  }

  // A touch of page furniture the desktop shell provides for itself.
  html = html.replace(
    '<title>InkNote</title>',
    `<title>InkNote — notes, drawing and boards</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="A free notebook that mixes typing, drawing and Milanote-style boards. Runs entirely in your browser — no account needed." />
  <link rel="icon" href="icon.png" />`
  );

  return html;
}

function main() {
  reset(OUT);

  fs.writeFileSync(path.join(OUT, 'index.html'), buildHtml());
  for (const f of ['styles.css', 'renderer.js']) {
    fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
  }
  for (const f of ['api-web.js', 'starter.js']) {
    fs.copyFileSync(path.join(WEB, f), path.join(OUT, f));
  }

  const icon = path.join(ROOT, 'build', 'icon.png');
  if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(OUT, 'icon.png'));

  // Stops GitHub Pages running the folder through Jekyll, which would ignore
  // files it doesn't recognise.
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  const files = fs.readdirSync(OUT).sort();
  console.log('built docs/ ->', files.join(', '));
  console.log('\nServe it locally with:  npx serve docs');
  console.log('Or publish: commit docs/ and set GitHub Pages to "main / docs".');
}

main();
