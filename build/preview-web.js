/* Serves docs/ over HTTP and drives it in real Chromium, checking that the
 * browser build boots, saves to IndexedDB and survives a reload.
 *
 *   npm i --no-save playwright && npm run web:test
 *
 * HTTP rather than file:// because IndexedDB is unavailable on file origins,
 * which is exactly the storage this build depends on.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const DOCS = path.join(__dirname, '..', 'docs');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json'
};

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(DOCS, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(DOCS) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, () => resolve(server)));
}

function findChromium() {
  const roots = ['/opt/pw-browsers', process.env.PLAYWRIGHT_BROWSERS_PATH].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      const candidate = path.join(root, dir, 'chrome-linux', 'chrome');
      if (dir.startsWith('chromium-') && fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

let failed = 0;
const check = (cond, msg) => {
  if (!cond) { console.error('  FAIL:', msg); failed++; }
  else console.log('  pass:', msg);
};

(async () => {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;

  const executablePath = findChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 700 } });
  const page = await ctx.newPage();

  const errors = [];
  let phase = 'boot';
  page.on('pageerror', e => { errors.push(`[${phase}] ${e}`); console.log('   !', phase, String(e).split('\n')[0]); });
  page.on('console', m => { if (m.type() === 'error') errors.push(`[${phase}] ${m.text()}`); });

  console.log('\nfirst visit'); phase = 'first visit';
  await page.goto(url);
  await page.waitForTimeout(700);

  check(await page.locator('#sectionList li').count() === 1, 'the starter notebook loads');
  check((await page.locator('#pageList li').count()) === 3, 'with its three pages');
  check(await page.locator('#items .card').count() > 0, 'and boxes on the board');
  check((await page.locator('#saveState').textContent()).trim() === 'Saved', 'save state is idle');

  console.log('\nediting'); phase = 'editing';
  await page.evaluate(() => {
    const T = window.__inknote;
    T.setTool('card');
    const page = T.activePage();
    page.items.push({ id: 'web-test', type: 'card', x: 900, y: 500, w: 240,
                      text: 'made in the browser', color: null });
    T.renderItems();
    T.selectItem('web-test');
    window.__inknote.notebook.sections[0].pages[0].title = 'Renamed page';
    return window.api.save(window.__inknote.notebook);
  });
  await page.waitForTimeout(300);

  console.log('\nafter a reload'); phase = 'after a reload';
  await page.reload();
  await page.waitForTimeout(700);

  const survived = await page.evaluate(() => {
    const T = window.__inknote;
    return {
      card: !!T.activePage().items.find(i => i.id === 'web-test'),
      title: T.activeSection().pages[0].title,
      pages: T.activeSection().pages.length
    };
  });
  check(survived.card, 'the box added before the reload is still there');
  check(survived.title === 'Renamed page', 'and the renamed page kept its name');
  check(survived.pages === 3, 'nothing else was lost');

  console.log('\nimages'); phase = 'images';
  const img = await page.evaluate(async () => {
    // a 1x1 png
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await window.api.saveImage(dataUrl);
    return { res, resolved: window.api.imageUrl(res.url) };
  });
  check(img.res.ok, 'an image saves into IndexedDB');
  check(/^inknote-img:\/\/local\//.test(img.res.url), 'and gets the same opaque id as on desktop');
  check(img.resolved.startsWith('blob:'), 'which resolves to a blob URL the browser can render');

  const afterReload = await page.evaluate(async (src) => {
    return src;
  }, img.res.url);
  await page.reload();
  await page.waitForTimeout(700);
  const stillThere = await page.evaluate((src) => window.api.imageUrl(src).startsWith('blob:'), afterReload);
  check(stillThere, 'and is still resolvable after a reload');

  console.log('\nshared rooms'); phase = 'shared rooms';
  check(await page.locator('#shareBtn').count() === 1, 'the Share button exists in the markup');
  check(await page.locator('#shareBtn').isHidden(),
    'but stays hidden until Firebase is configured');
  const syncState = await page.evaluate(() => ({
    present: !!window.INKNOTE_SYNC,
    configured: window.INKNOTE_SYNC && window.INKNOTE_SYNC.configured
  }));
  check(syncState.present, 'the sync layer loads');
  check(syncState.configured === false, 'and reports itself unconfigured, so the app stays local');

  // The pure parts of the sync layer are testable without a backend.
  const pure = await page.evaluate(() => {
    const I = window.INKNOTE_SYNC.internals;
    const nb = {
      version: 2, variables: [{ id: 'v', name: 'HP' }], recentLinks: [],
      sections: [{ id: 's', name: 'S', color: '#000', pages: [
        { id: 'p1', title: 'One', items: [{ id: 'i1', type: 'card', x: 1, y: 2, w: 3, text: 'a' }], strokes: [], links: [] },
        { id: 'p2', title: 'Two', items: [], strokes: [], links: [] }
      ] }]
    };
    const docs = I.toDocs(nb);
    const back = I.fromDocs(docs.structure, docs.pages);

    // one page edited -> only that page is in the diff
    const edited = JSON.parse(JSON.stringify(nb));
    edited.sections[0].pages[0].items[0].text = 'changed';
    const last = {
      structure: JSON.stringify(docs.structure),
      pages: new Map(Object.entries(docs.pages).map(([k, v]) => [k, JSON.stringify(v)]))
    };
    const diff = I.diffDocs(I.toDocs(edited), last);

    // a page removed -> it shows up as a deletion
    const fewer = JSON.parse(JSON.stringify(nb));
    fewer.sections[0].pages.pop();
    const diff2 = I.diffDocs(I.toDocs(fewer), last);

    return {
      pageCount: Object.keys(docs.pages).length,
      roundTripped: JSON.stringify(back.sections) === JSON.stringify(nb.sections),
      keptVariables: back.variables.length === 1,
      changed: diff.changedPages.map(c => c[0]),
      structureUnchanged: diff.structure === null,
      removed: diff2.removedPages,
      structureChanged: diff2.structure !== null,
      roomIds: [I.newRoomId(), I.newRoomId()],
      fromUrl: I.roomFromUrl('https://x.io/inknote/#room=abc123def0'),
      noRoom: I.roomFromUrl('https://x.io/inknote/'),
      link: I.roomLink('abc123def0', 'https://x.io/inknote/#room=old')
    };
  });

  check(pure.pageCount === 2, 'a notebook splits into one document per page');
  check(pure.roundTripped, 'and rebuilds back into the same notebook');
  check(pure.keptVariables, 'with the shared variable list intact');
  check(pure.changed.length === 1 && pure.changed[0] === 'p1',
    'editing one page queues only that page for writing');
  check(pure.structureUnchanged, 'and leaves the structure document alone');
  check(pure.removed.length === 1 && pure.removed[0] === 'p2', 'a deleted page is queued for deletion');
  check(pure.structureChanged, 'which does change the structure document');
  check(pure.roomIds[0] !== pure.roomIds[1] && pure.roomIds[0].length === 10,
    'room ids are ten characters and not repeated');
  check(pure.fromUrl === 'abc123def0', 'a room id is read back out of a URL');
  check(pure.noRoom === null, 'a plain URL has no room');
  check(pure.link === 'https://x.io/inknote/#room=abc123def0', 'and a link is built cleanly');

  // A remote notebook lands without disturbing which page you are on.
  const remote = await page.evaluate(() => {
    const T = window.__inknote;
    const before = T.notebook.activePageId;
    const nb = JSON.parse(JSON.stringify(T.notebook));
    nb.sections[0].pages[1].items.push({ id: 'from-elsewhere', type: 'card',
      x: 10, y: 10, w: 200, text: 'someone else made this', color: null });
    T.applyRemoteNotebook(nb);
    return {
      stayedOnPage: T.notebook.activePageId === before,
      gotTheEdit: !!T.findPage(nb.sections[0].pages[1].id).page.items
        .find(i => i.id === 'from-elsewhere')
    };
  });
  check(remote.stayedOnPage, 'a remote update leaves you on the page you were reading');
  check(remote.gotTheEdit, 'while still bringing in the change');

  console.log('\nno storage (private window / blocked cookies)'); phase = 'no storage';
  const blocked = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const bp = await blocked.newPage();
  await bp.addInitScript(() => {
    // Simulate a browser that refuses IndexedDB entirely.
    Object.defineProperty(window, 'indexedDB', { get() { throw new Error('blocked'); } });
  });
  const blockedErrors = [];
  bp.on('pageerror', e => blockedErrors.push(String(e)));
  await bp.goto(url);
  await bp.waitForTimeout(600);
  check(await bp.locator('#toolbar').isVisible(), 'the app still renders when storage is unavailable');
  await blocked.close();

  await page.screenshot({ path: path.join(__dirname, 'preview-web.png') });

  if (errors.length) { console.log('\npage errors:', errors); failed += errors.length; }
  console.log(failed ? `\nWEB TEST FAILED (${failed})` : '\nWEB TEST PASSED');
  if (failed) process.exitCode = 1;

  await browser.close();
  server.close();
  // Keep-alive sockets can hold the event loop open after everything useful
  // has finished, so say so explicitly.
  process.exit(failed ? 1 : 0);
})();
