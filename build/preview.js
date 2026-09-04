/* Renders a fixture notebook in a real browser and saves a screenshot, so
 * layout changes can be eyeballed without opening the app.
 *
 *   npm i --no-save playwright && node build/preview.js
 *
 * Not shipped with the app.
 */
const path = require('path');
const { chromium } = require('playwright');

const FIXTURE = {
  version: 2,
  variables: [
    { id: 'v1', name: 'Type' },
    { id: 'v2', name: 'Power' },
    { id: 'v3', name: 'Accuracy' }
  ],
  sections: [{
    id: 's1', name: 'My Notes', color: '#7a4bd4',
    pages: [
      { id: 'p1', title: 'Moves', strokes: [], links: [], items: [
        // a row of columns, each holding a field that hosts a link box
        { id: 'row', type: 'row', x: 40, y: 40, title: 'Water moves' },

        { id: 'c1', type: 'column', parent: 'row', order: 0, x: 0, y: 0, w: 300, title: 'Aqua Fang' },
        { id: 'c1f1', type: 'field', parent: 'c1', order: 0, x: 0, y: 0, w: 300, varId: 'v1', value: '' },
        { id: 'c1lk', type: 'link', parent: 'c1f1', order: 0, x: 0, y: 0, w: 240,
          target: 'p2', anchor: 'water', label: null },
        { id: 'c1f2', type: 'field', parent: 'c1', order: 1, x: 0, y: 0, w: 300, varId: 'v2', value: '4' },
        { id: 'c1f3', type: 'field', parent: 'c1', order: 2, x: 0, y: 0, w: 300, varId: 'v3', value: '85' },

        { id: 'c2', type: 'column', parent: 'row', order: 1, x: 0, y: 0, w: 300, title: 'Bite' },
        { id: 'c2f1', type: 'field', parent: 'c2', order: 0, x: 0, y: 0, w: 300, varId: 'v1', value: '' },
        { id: 'c2lk', type: 'link', parent: 'c2f1', order: 0, x: 0, y: 0, w: 240,
          target: 'p2', anchor: 'water', label: null },
        { id: 'c2f2', type: 'field', parent: 'c2', order: 1, x: 0, y: 0, w: 300, varId: 'v2', value: '7' },
        { id: 'c2sub', type: 'column', parent: 'c2', order: 2, x: 0, y: 0, w: 260, title: 'Notes' },
        { id: 'c2subcard', type: 'card', parent: 'c2sub', order: 0, x: 0, y: 0, w: 240,
          text: 'flinch chance', color: null }
      ] },
      { id: 'p2', title: 'TYPES', strokes: [], links: [], items: [
        { id: 'water', type: 'card', x: 40, y: 40, w: 240, text: 'Pikachu', color: '#1f5fd0' }
      ] }
    ]
  }],
  activeSectionId: 's1',
  activePageId: 'p1'
};

(async () => {
  // Point at whichever chromium is actually on this machine — the version
  // Playwright expects and the one installed don't always match.
  const fs = require('fs');
  const roots = ['/opt/pw-browsers', process.env.PLAYWRIGHT_BROWSERS_PATH].filter(Boolean);
  let executablePath;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      const candidate = path.join(root, dir, 'chrome-linux', 'chrome');
      if (dir.startsWith('chromium-') && fs.existsSync(candidate)) { executablePath = candidate; break; }
    }
    if (executablePath) break;
  }
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });

  await page.addInitScript((data) => {
    window.api = {
      load: async () => data,
      save: async () => ({ ok: true }),
      dataPath: async () => '',
      exportNotebook: async () => ({ ok: true }),
      importNotebook: async () => ({ ok: false, canceled: true }),
      saveImage: async () => ({ ok: false }),
      deleteImage: async () => ({ ok: true }),
      readImageFile: async () => ({ ok: false }),
      pathForFile: () => null
    };
  }, FIXTURE);

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('file://' + path.join(__dirname, '..', 'src', 'index.html'));
  await page.waitForTimeout(500);

  // Open a link box's picker and type, so the block rows are on screen.
  await page.evaluate(() => {
    const T = window.__inknote;
    T.recordLinkTarget('p2', 'water');
    const el = document.querySelector('[data-id="c1lk"]');
    T.openPagePicker(el, () => {}, () => {});
  });
  await page.waitForTimeout(120);
  await page.fill('#pagePickerSearch', 'pika');
  await page.waitForTimeout(200);

  const out = path.join(__dirname, 'preview.png');
  await page.screenshot({ path: out });

  // Report the measured sizes, which is the part worth asserting on.
  const sizes = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : null;
    };
    return {
      rowTitle: text('[data-id="row"] > .col-bar > .col-head'),
      rowCount: text('[data-id="row"] > .col-bar > .col-count'),
      col1Count: text('[data-id="c1"] > .col-bar > .col-count'),
      col2Count: text('[data-id="c2"] > .col-bar > .col-count'),
      subCount: text('[data-id="c2sub"] > .col-bar > .col-count'),
      linkLabel: text('[data-id="c1lk"] .pl-label'),
      linkSub: text('[data-id="c1lk"] .pl-sub'),
      hostField: box('[data-id="c1f1"]'),
      pickerRows: Array.from(document.querySelectorAll('#pagePickerList li'))
        .map(li => li.className + ': ' + li.textContent.trim().slice(0, 40))
    };
  });

  console.log('measurements:', JSON.stringify(sizes, null, 2));
  if (errors.length) console.log('page errors:', errors);
  console.log('screenshot ->', out);

  await browser.close();
})();
