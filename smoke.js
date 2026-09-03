// Headless smoke test: boot the renderer against index.html in jsdom and
// exercise the main flows. Not shipped with the app.
//   node smoke.js        (needs: npm install --no-save jsdom)
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'src', 'index.html'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

// --- stubs jsdom doesn't provide -------------------------------------------
const ctxStub = new Proxy({}, { get: (_t, k) => (k === 'canvas' ? {} : () => {}) });
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.PointerEvent = window.MouseEvent;
window.Element.prototype.setPointerCapture = () => {};
window.Element.prototype.releasePointerCapture = () => {};

// jsdom returns all-zero rects. Fake a layout good enough for the geometry
// code: the stage fills a 1200x800 viewport, and items report the size their
// inline styles claim.
const RECT = (x, y, w, h) => ({
  x, y, left: x, top: y, width: w, height: h,
  right: x + w, bottom: y + h, toJSON() { return this; }
});
window.Element.prototype.getBoundingClientRect = function () {
  if (this.id === 'stage') return RECT(0, 0, 1200, 800);
  const item = this.classList.contains('item') ? this : this.closest('.item');
  if (!item) return RECT(0, 0, 0, 0);
  const px = (v, d) => (v && v.endsWith('px') ? parseFloat(v) : d);

  // Apply the same world -> screen mapping the real layout would, so code
  // that converts a rect back into world coordinates round-trips exactly.
  const cam = (window.__inknote && window.__inknote.cam) || { x: 0, y: 0, scale: 1 };
  const wx = px(item.style.left, 0);
  const wy = px(item.style.top, 0);
  const ww = px(item.style.width, 200);
  const wh = px(item.style.height, 120);
  return RECT(
    (wx - cam.x) * cam.scale, (wy - cam.y) * cam.scale,
    ww * cam.scale, wh * cam.scale
  );
};

// v0.1-shaped notebook, to prove migration works.
const LEGACY = {
  sections: [{
    id: 'sec1', name: 'Old Section', color: '#7a4bd4',
    pages: [{
      id: 'pg1', title: 'Old Page',
      strokes: [{ id: 's1', tool: 'pen', color: '#000', size: 3, points: [[1, 1, .5], [9, 9, .5]] }],
      texts: [{ id: 't1', x: 40, y: 50, w: 300, text: 'legacy note' }]
    }]
  }],
  activeSectionId: 'sec1',
  activePageId: 'pg1'
};

let saved = null;
let savedImage = null;
window.api = {
  load: async () => JSON.parse(JSON.stringify(LEGACY)),
  save: async (d) => { saved = d; return { ok: true }; },
  dataPath: async () => '/tmp/notebook.json',
  exportNotebook: async () => ({ ok: true }),
  importNotebook: async () => ({ ok: false, canceled: true }),
  saveImage: async (dataUrl) => { savedImage = dataUrl; return { ok: true, url: 'inknote-img://local/x.png' }; },
  deleteImage: async () => ({ ok: true }),
  readImageFile: async () => ({ ok: false }),
  pathForFile: () => null
};

window.eval(fs.readFileSync(path.join(__dirname, 'src', 'renderer.js'), 'utf8'));

// --- tiny assertion harness ------------------------------------------------
let failed = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error('  FAIL:', msg); failed++; }
  else console.log('  pass:', msg);
};
const group = (name) => console.log('\n' + name);
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const doc = window.document;
const el = (s) => doc.querySelector(s);
const all = (s) => Array.from(doc.querySelectorAll(s));

function pointer(type, target, opts = {}) {
  const ev = new window.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 0, ...opts
  });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  Object.defineProperty(ev, 'pressure', { value: 0.5 });
  target.dispatchEvent(ev);
  return ev;
}

function key(k, opts = {}) {
  window.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k,
    bubbles: true, cancelable: true, ...opts
  }));
}

const T = window.__inknote;
const elFor = (id) => doc.querySelector(`#items [data-id="${id}"]`);

(async function run() {
  await tick(60);

  // =========================================================================
  group('migration from v0.1');
  const page = T.activePage();
  assert(T.notebook.version === 2, 'notebook upgraded to version 2');
  assert(!('texts' in page), 'legacy texts array removed');
  assert(page.items.length === 1 && page.items[0].type === 'card', 'legacy text became a card');
  assert(page.items[0].text === 'legacy note', 'card kept its text');
  assert(page.strokes.length === 1, 'legacy ink preserved');
  assert(all('#items .card').length === 1, 'migrated card rendered to the DOM');
  assert(Array.isArray(page.links), 'links array added');

  // =========================================================================
  group('existing links seed the remembered targets');
  // The legacy fixture has no links, so seed from a notebook that does.
  {
    const withLinks = T.migrate({
      sections: [{
        id: 'sx', name: 'S', color: '#000', pages: [
          { id: 'px', title: 'A', strokes: [], items: [
            { id: 'l1', type: 'link', x: 0, y: 0, w: 200, target: 'py', anchor: 'b1' },
            { id: 'l2', type: 'link', x: 0, y: 0, w: 200, target: 'py', anchor: null },
            { id: 'l3', type: 'link', x: 0, y: 0, w: 200, target: 'py', anchor: 'b1' },
            { id: 'l4', type: 'link', x: 0, y: 0, w: 200, target: null, anchor: null }
          ], links: [] },
          { id: 'py', title: 'B', strokes: [], items: [
            { id: 'b1', type: 'card', x: 0, y: 0, w: 200, text: 'Pikachu', color: null }
          ], links: [] }
        ]
      }],
      activeSectionId: 'sx', activePageId: 'px'
    });
    assert(withLinks.recentLinks.length === 2,
      'links already in the notebook seed the remembered list');
    assert(withLinks.recentLinks.some(r => r.anchor === 'b1'), 'the block target is there');
    assert(withLinks.recentLinks.some(r => r.anchor === null), 'and the page-level one');
    assert(!withLinks.recentLinks.some(r => r.pageId === null), 'unfinished links are skipped');

    // seeding happens once — an existing list is left alone
    const already = T.migrate({
      recentLinks: [{ pageId: 'py', anchor: null }],
      sections: withLinks.sections,
      activeSectionId: 'sx', activePageId: 'px'
    });
    assert(already.recentLinks.length === 1, 'an existing history is not re-seeded');
  }

  // =========================================================================
  group('ink still works');
  T.setTool('pen');
  const stage = el('#stage');
  pointer('pointerdown', stage, { clientX: 100, clientY: 100 });
  pointer('pointermove', stage, { clientX: 150, clientY: 140 });
  pointer('pointermove', stage, { clientX: 200, clientY: 100 });
  pointer('pointerup', stage, { clientX: 200, clientY: 100 });
  assert(page.strokes.length === 2, 'a new stroke was recorded');
  assert(page.strokes[1].points.length >= 2, 'stroke captured multiple points');
  assert(el('#overlay').classList.contains('ink-mode'), 'ink tools make items click-through');

  // =========================================================================
  group('cards');
  T.setTool('card');
  pointer('pointerdown', stage, { clientX: 300, clientY: 220 });
  assert(page.items.length === 2, 'card tool created a card');
  const card = page.items[1];
  const cardEl = el(`#items [data-id="${card.id}"]`);
  assert(!!cardEl, 'card element mounted');

  const body = cardEl.querySelector('.card-body');
  body.textContent = 'hello board';
  body.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert(card.text === 'hello board', 'typing updates the model');
  assert(cardEl.dataset.empty === 'false', 'placeholder clears once there is text');

  // recolouring a selected card
  T.selectItem(card.id);
  all('#colorRow .swatch-btn')[1].click();
  assert(card.color === '#1f5fd0', 'swatch recolours the selected card');

  // =========================================================================
  group('click selects, double-click edits');
  assert(cardEl.querySelector('.card-body').contentEditable !== 'true',
    'card text is not editable until asked for');
  T.beginEdit(card.id);
  assert(T.editingItemId === card.id, 'double-click opens the editor');
  assert(cardEl.querySelector('.card-body').contentEditable === 'true', 'field became editable');
  T.stopEditing();
  assert(T.editingItemId === null, 'editor closed');
  assert(cardEl.querySelector('.card-body').contentEditable !== 'true', 'field locked again');

  // =========================================================================
  group('columns');
  T.setTool('column');
  pointer('pointerdown', stage, { clientX: 700, clientY: 150 });
  const col = page.items.find(i => i.type === 'column');
  assert(!!col, 'column tool created a column');
  assert(col.h === undefined, 'columns carry no fixed height — they fit their contents');
  assert(!!el(`#items [data-id="${col.id}"] .col-body`), 'column has a drop body');
  assert(T.childrenOf(page, col.id).length === 0, 'new column is empty');

  T.dropIntoColumn(card, col, { x: 0, y: 0 });
  assert(card.parent === col.id, 'card re-parented into the column');
  assert(card.order === 0, 'card given an order index');

  // a second card lands after the first
  T.setTool('card');
  pointer('pointerdown', stage, { clientX: 320, clientY: 400 });
  const card2 = page.items[page.items.length - 1];
  card2.text = 'second';
  T.dropIntoColumn(card2, col, { x: 99999, y: 99999 });
  const kids = T.childrenOf(page, col.id);
  assert(kids.length === 2, 'column holds two cards');
  assert(kids[0].id === card.id && kids[1].id === card2.id, 'drop order respected');

  // =========================================================================
  group('checklists');
  T.setTool('checklist');
  pointer('pointerdown', stage, { clientX: 420, clientY: 620 });
  const list = page.items[page.items.length - 1];
  assert(list.type === 'checklist', 'checklist tool created a checklist');
  assert(list.rows.length === 1, 'starts with one empty row');

  const listEl = el(`#items [data-id="${list.id}"]`);
  assert(listEl.classList.contains('card'), 'checklist reuses the card chrome');
  assert(listEl.querySelectorAll('.chk-row').length === 1, 'one row rendered');
  assert(/0 of 1 done/.test(listEl.querySelector('.chk-foot').textContent), 'progress footer shown');

  // typing into a row
  const row0 = listEl.querySelector('.chk-row .chk-text');
  row0.textContent = 'buy milk';
  row0.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert(list.rows[0].text === 'buy milk', 'typing updates the row');

  // Enter adds a row below
  row0.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert(list.rows.length === 2, 'Enter adds a new row');
  assert(list.rows[0].text === 'buy milk' && list.rows[1].text === '', 'new row inserted after the first');

  // ticking a box
  const freshEl = el(`#items [data-id="${list.id}"]`);
  freshEl.querySelectorAll('.chk-row .chk-box')[0].dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert(list.rows[0].done === true, 'clicking the box ticks the row');
  assert(freshEl.querySelectorAll('.chk-row')[0].classList.contains('done'), 'row shows as done');
  assert(/1 of 2 done/.test(freshEl.querySelector('.chk-foot').textContent), 'progress footer updated');

  // Backspace on an empty row removes it
  const rows = freshEl.querySelectorAll('.chk-row .chk-text');
  rows[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
  assert(list.rows.length === 1, 'Backspace on an empty row removes it');

  // checklists drop into columns like cards
  T.dropIntoColumn(list, col, { x: 99999, y: 99999 });
  assert(list.parent === col.id, 'checklist dropped into a column');
  assert(T.childrenOf(page, col.id).some(c => c.id === list.id), 'column lists the checklist');
  T.renderItems();
  const nested = el(`#items [data-id="${col.id}"] .col-body [data-id="${list.id}"]`);
  assert(!!nested, 'checklist renders nested inside the column');
  assert(nested.querySelectorAll('.chk-row').length === 1, 'its rows survive the re-parent');

  // colour follows the card rules
  T.selectItem(list.id);
  all('#colorRow .swatch-btn')[3].click();
  assert(list.color === '#1f8a52', 'swatch recolours a selected checklist');

  // =========================================================================
  group('images');
  const imgItem = { id: 'img1', type: 'image', x: 500, y: 500, w: 320, src: 'inknote-img://local/x.png' };
  page.items.push(imgItem);
  assert(page.items.filter(i => i.type === 'image').length === 1, 'image item added to model');

  // =========================================================================
  group('nested columns');
  T.setTool('column');
  const outerEl = el(`#items [data-id="${col.id}"]`);
  const outerBody = outerEl.querySelector(':scope > .col-body');
  pointer('pointerdown', outerBody, { clientX: 720, clientY: 300 });
  const inner = page.items[page.items.length - 1];
  assert(inner.type === 'column', 'column tool made another column');
  assert(inner.parent === col.id, 'and put it inside the one that was clicked');
  T.renderItems();
  assert(!!el(`#items [data-id="${col.id}"] .col-body [data-id="${inner.id}"]`),
    'nested column renders inside its parent');

  // a card can go into the inner column
  T.setTool('card');
  const innerBody = el(`#items [data-id="${inner.id}"]`).querySelector(':scope > .col-body');
  pointer('pointerdown', innerBody, { clientX: 730, clientY: 320 });
  const deepCard = page.items[page.items.length - 1];
  deepCard.text = 'two levels down';
  assert(deepCard.parent === inner.id, 'card created inside the nested column');
  assert(T.descendantIds(col.id).has(deepCard.id), 'outer column owns it transitively');

  // cycles are refused
  assert(T.descendantIds(inner.id).has(inner.id), 'descendantIds includes the item itself');
  const forbidden = T.descendantIds(col.id);
  assert(forbidden.has(inner.id), 'a column cannot be dropped into its own child');

  // deleting the outer column would take the whole subtree
  T.selectItem(col.id);
  el(`#items [data-id="${col.id}"]`).querySelector(':scope > .kill').click();
  await tick(10);
  const subtreeCount = T.descendantIds(col.id).size - 1;
  assert(new RegExp(`${subtreeCount} items`).test(el('#modalBody').textContent),
    'delete warning counts the whole nested subtree');
  el('#modalCancel').click();
  await tick(10);

  // =========================================================================
  group('image boxes are placeholders');
  T.setTool('image');
  pointer('pointerdown', stage, { clientX: 520, clientY: 480 });
  const frame = page.items[page.items.length - 1];
  assert(frame.type === 'image' && frame.src === null, 'image tool places an empty frame');
  const frameEl = el(`#items [data-id="${frame.id}"]`);
  assert(frameEl.classList.contains('empty'), 'frame renders in its empty state');
  assert(!!frameEl.querySelector('.img-add'), 'frame has a + button');

  frameEl.querySelector('.img-add').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick(10);
  await T.attachImage(frame, 'data:image/png;base64,AAAA');
  assert(frame.src === 'inknote-img://local/x.png', 'attaching sets the source');
  const filledEl = el(`#items [data-id="${frame.id}"]`);
  assert(!filledEl.classList.contains('empty'), 'frame is no longer empty');
  assert(!!filledEl.querySelector('img'), 'picture rendered');
  assert(frame.h === undefined, 'stored height cleared so the aspect ratio can be measured');

  // =========================================================================
  group('page links');
  el('#addPage').click();
  await tick(10);
  const otherPage = T.activeSection().pages[T.activeSection().pages.length - 1];
  otherPage.title = 'Fireball';
  all('#pageList li')[0].click();
  await tick(10);

  const home = T.activePage();
  T.setTool('link');
  pointer('pointerdown', stage, { clientX: 640, clientY: 640 });
  const link = home.items[home.items.length - 1];
  assert(link.type === 'link' && link.target === null, 'link tool places an unlinked box');
  await tick(20);
  assert(el('#pagePicker').hidden === false, 'the picker opens straight away');

  // searching narrows the list
  const search = el('#pagePickerSearch');
  search.value = 'fire';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  const hits = all('#pagePickerList li[data-id]');
  assert(hits.length === 1, 'search filters the page list');
  assert(/Fireball/.test(hits[0].textContent), 'the matching page is the one shown');

  search.value = 'zzzz';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert(!!el('#pagePickerList .picker-empty'), 'a no-match state is shown');

  T.choosePage(otherPage.id);
  await tick(10);
  assert(el('#pagePicker').hidden === true, 'choosing closes the picker');
  assert(link.target === otherPage.id, 'link points at the chosen page');

  const linkEl = el(`#items [data-id="${link.id}"]`);
  assert(/Fireball/.test(linkEl.querySelector('.pl-label').textContent),
    'label defaults to the page title');
  assert(T.linkLabel(link) === 'Fireball', 'a page-level link is named after the page');
  assert(/Fireball/.test(linkEl.querySelector('.pl-sub').textContent),
    'subtitle shows where it points');

  // renaming the label leaves the page alone
  const plLabel = linkEl.querySelector('.pl-label');
  plLabel.textContent = 'fire move';
  plLabel.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert(link.label === 'fire move', 'label renamed');
  assert(otherPage.title === 'Fireball', 'the page itself keeps its name');
  assert(T.linkLabel(link, T.findPage(link.target)) === 'fire move', 'custom label wins');

  // the open button jumps to that page
  el(`#items [data-id="${link.id}"] .pl-open`).dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick(10);
  assert(T.notebook.activePageId === otherPage.id, 'open button navigates to the page');
  all('#pageList li')[0].click();
  await tick(10);

  // links drop into columns like anything else
  T.dropIntoColumn(link, col, { x: 99999, y: 99999 });
  assert(link.parent === col.id, 'link box dropped into a column');

  // a link to a deleted page degrades instead of breaking
  const ghost = { id: 'ghost1', type: 'link', x: 10, y: 10, w: 240, target: 'nope', label: null };
  T.activePage().items.push(ghost);
  T.renderItems();
  const ghostEl = el('#items [data-id="ghost1"]');
  assert(ghostEl.classList.contains('broken'), 'a dangling link is flagged');
  assert(/no longer exists/.test(ghostEl.querySelector('.pl-sub').textContent),
    'and says so plainly');

  // =========================================================================
  group('links to a specific block');
  // Give the target page something worth linking to.
  const fireball = T.findPage(otherPage.id).page;
  fireball.items = [
    { id: 'blk1', type: 'column', x: 40, y: 40, w: 300, title: 'Damage' },
    { id: 'blk2', type: 'card', x: 400, y: 40, w: 240, text: 'scaling notes', color: null }
  ];

  assert(T.blockLabel(fireball.items[0]) === 'Damage', 'a column reads as its title');
  assert(T.blockLabel(fireball.items[1]) === 'scaling notes', 'a card reads as its text');
  assert(T.blockLabel({ type: 'image' }) === 'an image', 'an image has a generic name');

  // the picker offers a "Go to page" button when block picking is possible
  const link2El = el(`#items [data-id="${link.id}"]`) || el('#items .pagelink');
  T.selectItem(link.id);
  el(`#items [data-id="${link.id}"] .pl-pick`).dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick(10);
  assert(el('#pagePicker').hidden === false, 'picker reopened');
  assert(!!el('#pagePickerList li[data-id] .picker-go'), 'each row offers "Go to page"');

  // walk the real flow: go to the page, click a block
  const homePageId = T.activePage().id;
  el(`#pagePickerList li[data-id="${otherPage.id}"] .picker-go`).dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick(10);
  assert(el('#pagePicker').hidden === true, 'picker closed on "Go to page"');
  assert(T.notebook.activePageId === otherPage.id, 'navigated to the target page');
  assert(el('#blockPickBar').hidden === false, 'the pick-a-block bar is showing');
  assert(/Fireball/.test(el('#blockPickWhat').textContent), 'the bar names the page');
  assert(!!T.blockPick, 'block-pick state is live across the navigation');

  // Clicking blank board must NOT commit — it pans, so you can go looking
  // for the box you want.
  const camBefore = { x: T.cam.x, y: T.cam.y };
  pointer('pointerdown', el('#stage'), { clientX: 600, clientY: 400 });
  pointer('pointermove', el('#stage'), { clientX: 500, clientY: 330 });
  pointer('pointerup', el('#stage'), { clientX: 500, clientY: 330 });
  await tick(10);
  assert(!!T.blockPick, 'clicking blank board does not end the pick');
  assert(link.anchor !== null || link.target === otherPage.id,
    'and does not silently link the whole page');
  assert(T.cam.x !== camBefore.x || T.cam.y !== camBefore.y,
    'dragging blank board pans the view instead');
  assert(T.notebook.activePageId === otherPage.id, 'still on the target page');

  pointer('pointerdown', el('#items [data-id="blk1"]'));
  await tick(10);
  assert(!T.blockPick, 'picking a block ends the mode');
  assert(el('#blockPickBar').hidden === true, 'the bar goes away');
  assert(T.notebook.activePageId === homePageId, 'returned to the page holding the link');
  assert(link.target === otherPage.id, 'link still points at the page');
  assert(link.anchor === 'blk1', 'and now names the block');

  const anchored = el(`#items [data-id="${link.id}"]`);
  assert(/Damage/.test(anchored.querySelector('.pl-sub').textContent),
    'subtitle names the block it points at');
  // A name you typed always wins over the automatic one.
  assert(T.linkLabel(link) === 'fire move', 'a custom label still takes priority');

  // With no custom label, an anchored link is named after the block.
  link.label = null;
  T.renderItems();
  assert(T.linkLabel(link) === 'Damage',
    'an anchored link is named after the block, not the page');
  assert(el(`#items [data-id="${link.id}"]`).querySelector('.pl-label').textContent === 'Damage',
    'and the box shows that name');
  link.label = 'fire move';
  T.renderItems();

  // following it lands on that page
  anchored.querySelector('.pl-open').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick(20);
  assert(T.notebook.activePageId === otherPage.id, 'following the link opens the page');

  // cancelling a pick leaves the link alone
  T.goToPage(homePageId);
  await tick(10);
  const beforeAnchor = link.anchor;
  T.startBlockPick(link, otherPage.id);
  await tick(10);
  assert(!!T.blockPick, 'pick mode started again');
  el('#blockPickCancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick(10);
  assert(!T.blockPick, 'cancel ends the mode');
  assert(link.anchor === beforeAnchor, 'cancel changed nothing');
  assert(T.notebook.activePageId === homePageId, 'cancel brought us back');

  // "link the whole page" clears the anchor
  T.startBlockPick(link, otherPage.id);
  await tick(10);
  el('#blockPickWhole').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick(10);
  assert(link.anchor === null, 'whole-page option drops the anchor');
  assert(link.target === otherPage.id, 'but keeps the page');

  // a deleted block degrades the link to page-level
  link.anchor = 'blk2';
  T.goToPage(otherPage.id);
  await tick(10);
  T.selectItem('blk2');
  el('#items [data-id="blk2"]').querySelector(':scope > .kill').click();
  await tick(10);
  el('#modalOk').click();
  await tick(10);
  assert(link.anchor === null, 'deleting a block clears links anchored to it');

  T.goToPage(homePageId);
  await tick(10);

  // =========================================================================
  group('the picker remembers link targets');
  {
    const home2 = T.activePage();
    // give the target page a couple of named boxes
    const fb = T.findPage(otherPage.id).page;
    fb.items.push(
      { id: 'pk', type: 'card', x: 40, y: 300, w: 240, text: 'Pikachu', color: null },
      { id: 'sq', type: 'card', x: 40, y: 400, w: 240, text: 'Squirtle', color: null }
    );

    // with nothing typed, the block list is exactly the remembered targets —
    // never a dump of every box in the notebook
    const knownKeys = new Set(T.recentLinkTargets()
      .filter(r => r.anchor).map(r => `${r.pageId}|${r.anchor}`));
    assert(T.blockChoices('').every(b => knownKeys.has(`${b.pageId}|${b.itemId}`)),
      'an empty search offers only blocks you have linked to before');
    assert(!T.blockChoices('').some(b => b.itemId === 'pk'),
      'a block never linked to is not offered until you type');

    // typing finds blocks by their text, case-insensitively
    const byName = T.blockChoices('pika');
    assert(byName.some(b => b.itemId === 'pk'), 'typing part of a name finds the block');
    assert(T.blockChoices('PIKA').some(b => b.itemId === 'pk'), 'matching ignores case');
    assert(T.blockChoices('pi').some(b => b.itemId === 'pk'), 'two letters are enough');
    assert(!T.blockChoices('pika').some(b => b.itemId === 'sq'), 'and it does not match everything');

    // two boxes with the same text collapse to one row
    fb.items.push({ id: 'pk2', type: 'card', x: 300, y: 300, w: 240, text: 'Pikachu', color: null });
    const dupes = T.blockChoices('pika').filter(b => b.pageId === otherPage.id);
    assert(dupes.length === 1, 'same-named boxes on one page show as a single row');

    // the one you have linked to before is the one kept
    T.recordLinkTarget(otherPage.id, 'pk2');
    assert(T.blockChoices('pika').filter(b => b.pageId === otherPage.id)[0].itemId === 'pk2',
      'and the remembered one is what survives');
    fb.items = fb.items.filter(i => i.id !== 'pk2');
    T.notebook.recentLinks = T.notebook.recentLinks.filter(r => r.anchor !== 'pk2');

    // choosing one records it
    T.recordLinkTarget(otherPage.id, 'pk');
    const remembered = T.recentLinkTargets();
    assert(remembered.length >= 1, 'the target was remembered');
    assert(remembered[0].anchor === 'pk', 'most recent first');

    // now an empty search offers it without typing
    const empty = T.blockChoices('');
    assert(empty.some(b => b.itemId === 'pk'), 'a remembered block shows with an empty search');

    // recording the same one twice does not duplicate it
    T.recordLinkTarget(otherPage.id, 'pk');
    assert(T.recentLinkTargets().filter(r => r.anchor === 'pk').length === 1,
      'repeats are not duplicated');

    // remembered entries are ranked above other matches
    T.recordLinkTarget(otherPage.id, 'sq');
    const ranked = T.blockChoices('');
    assert(ranked[0].itemId === 'sq', 'the newest target sorts first');

    // a target whose block was deleted drops out
    fb.items = fb.items.filter(i => i.id !== 'sq');
    assert(!T.recentLinkTargets().some(r => r.anchor === 'sq'),
      'a remembered block that no longer exists is forgotten');

    // the picker renders both kinds of row
    const linkBox = { id: 'rl9', type: 'link', x: 50, y: 900, w: 240,
                      target: null, anchor: null, label: null };
    home2.items.push(linkBox);
    T.renderItems();
    T.openPagePicker(elFor('rl9'), () => {}, () => {});
    await tick(10);
    const search2 = el('#pagePickerSearch');
    search2.value = 'pika';
    search2.dispatchEvent(new window.Event('input', { bubbles: true }));
    const blockRows = all('#pagePickerList li.picker-block');
    assert(blockRows.length >= 1, 'a block row appears in the list');
    assert(/Pikachu/.test(blockRows[0].textContent), 'showing the block name');
    assert(/TYPES|Fireball/.test(blockRows[0].textContent) || /›/.test(blockRows[0].textContent),
      'with the page it lives on underneath');
    assert(blockRows[0].dataset.id === `block:${otherPage.id}:pk`, 'and an identifying row id');
    assert(!!el('#pagePickerList .picker-head'), 'the two kinds are separated by headings');

    // picking a block row sets target and anchor in one go
    T.closePagePicker();
    const elBox = elFor('rl9');
    T.openPagePicker(elBox, (pageId, anchor) => {
      linkBox.target = pageId;
      linkBox.anchor = anchor || null;
    }, () => {});
    await tick(5);
    T.commitPickerRow(`block:${otherPage.id}:pk`);
    assert(linkBox.target === otherPage.id, 'the page was set');
    assert(linkBox.anchor === 'pk', 'and the block, without going to the page');
  }

  // =========================================================================
  group('arrows');
  T.setTool('arrow');
  const colEl = el(`#items [data-id="${col.id}"]`);
  // re-render put fresh nodes in place; grab the image element after a render
  T.selectItem(null);
  pointer('pointerdown', colEl);
  assert(el('#linkHint').hidden === false, 'first click arms the arrow tool');
  assert(colEl.classList.contains('link-source'), 'source item is marked');

  // connect column -> a card inside it is odd; use the second free item instead
  T.setTool('card');
  pointer('pointerdown', stage, { clientX: 900, clientY: 500 });
  const target = page.items[page.items.length - 1];
  target.text = 'target';
  T.setTool('arrow');
  pointer('pointerdown', el(`#items [data-id="${col.id}"]`));
  pointer('pointerdown', el(`#items [data-id="${target.id}"]`));
  assert(page.links.length === 1, 'arrow created between two items');
  assert(page.links[0].from === col.id && page.links[0].to === target.id, 'arrow endpoints correct');
  assert(el('#linkHint').hidden === true, 'hint hides after connecting');

  // duplicate arrows are ignored
  pointer('pointerdown', el(`#items [data-id="${col.id}"]`));
  pointer('pointerdown', el(`#items [data-id="${target.id}"]`));
  assert(page.links.length === 1, 'duplicate arrow between same pair rejected');

  await tick(40); // link drawing is batched into an animation frame
  assert(all('#linkPaths g').length === 1, 'arrow rendered as an svg group');
  assert(all('#linkPaths path.link')[0].getAttribute('marker-end') === 'url(#arrowhead)', 'arrow has a head');

  // edge geometry: a point to the right of a box exits its right edge
  const p = T.edgePoint({ x: 0, y: 0, w: 100, h: 100 }, 500, 50);
  assert(Math.abs(p.x - 100) < 0.001 && Math.abs(p.y - 50) < 0.001, 'edgePoint lands on the box border');

  // =========================================================================
  group('variable fields');
  const varPage = T.activePage();

  // the notebook starts with no variables
  assert(Array.isArray(T.notebook.variables), 'notebook carries a variables list');
  const varsAtStart = T.notebook.variables.length;

  T.setTool('field');
  pointer('pointerdown', el('#stage'), { clientX: 150, clientY: 250 });
  const fld = varPage.items[varPage.items.length - 1];
  assert(fld.type === 'field', 'field tool placed a field box');
  assert(fld.varId === null && fld.value === '', 'it starts blank');
  await tick(30);
  assert(el('#varPicker').hidden === false, 'the variable picker opens straight away');

  // creating a variable from the search text
  const vs = el('#varPickerSearch');
  vs.value = 'Health';
  vs.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert(!!el('#varPickerList .var-create'), 'offers to create the typed name');
  el('#varPickerList .var-create').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick(10);
  assert(T.notebook.variables.length === varsAtStart + 1, 'variable created');
  assert(!!T.findVariableByName('Health'), 'and findable by name');
  assert(fld.varId === T.findVariableByName('Health').id, 'the box points at it');

  let fldEl = el(`#items [data-id="${fld.id}"]`);
  assert(fldEl.querySelector('.fld-name').textContent === 'Health', 'box shows the variable name');
  assert(fldEl.querySelector('.fld-value').dataset.empty === 'true', 'value starts empty');

  // typing a value
  const valueEl = fldEl.querySelector('.fld-value');
  valueEl.textContent = '70';
  valueEl.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert(fld.value === '70', 'value saved on the box');

  // a second box using the same variable keeps its own value
  T.setTool('field');
  pointer('pointerdown', el('#stage'), { clientX: 150, clientY: 340 });
  const fld2 = varPage.items[varPage.items.length - 1];
  await tick(30);
  T.chooseVariable(T.findVariableByName('Health').id);
  await tick(10);
  assert(fld2.varId === fld.varId, 'both boxes share the variable');
  assert(fld2.value === '', 'the second box has its own, empty value');
  assert(fld.value === '70', 'the first box kept its value');

  // more variables, and the dropdown lists them all
  T.createVariable('Attack');
  T.createVariable('Speed');
  assert(T.createVariable('health') === T.findVariableByName('Health'),
    'names are matched case-insensitively rather than duplicated');

  T.openVariablePicker(el(`#items [data-id="${fld.id}"]`), () => {});
  await tick(10);
  const names = all('#varPickerList li[data-id] .picker-title').map(n => n.textContent);
  assert(names.length === 3, 'every variable is listed');
  assert(names.join(',') === 'Attack,Health,Speed', 'sorted alphabetically');

  // search narrows it
  vs.value = 'spe';
  vs.dispatchEvent(new window.Event('input', { bubbles: true }));
  const filtered = all('#varPickerList li[data-id] .picker-title').map(n => n.textContent);
  assert(filtered.length === 1 && filtered[0] === 'Speed', 'search filters the list');
  assert(!!el('#varPickerList .var-create'),
    'a partial name still offers to create it — "spe" is not "Speed"');

  vs.value = 'Speed';
  vs.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert(!el('#varPickerList .var-create'), 'no create row once the name matches exactly');
  T.closeVariablePicker();

  // renaming a variable renames it everywhere at once
  assert(T.renameVariable(fld.varId, 'Max Health') === true, 'rename accepted');
  T.renderItems();
  fldEl = el(`#items [data-id="${fld.id}"]`);
  const fld2El = el(`#items [data-id="${fld2.id}"]`);
  assert(fldEl.querySelector('.fld-name').textContent === 'Max Health', 'first box updated');
  assert(fld2El.querySelector('.fld-name').textContent === 'Max Health', 'second box too');
  assert(fld.value === '70' && fld2.value === '', 'values were untouched by the rename');

  assert(T.renameVariable(fld.varId, 'Attack') === false, 'renaming onto an existing name is refused');

  // usage count
  assert(T.fieldsUsingVariable(fld.varId).length === 2, 'usage count is right');

  // deleting a variable leaves the boxes and their values in place
  T.deleteVariable(fld.varId);
  assert(!T.variableById(fld.varId), 'variable gone from the list');
  assert(fld.varId === null && fld2.varId === null, 'boxes released the variable');
  assert(fld.value === '70', 'but kept their values');
  const releasedEl = el(`#items [data-id="${fld.id}"]`);
  assert(releasedEl.classList.contains('unset'), 'box shows as needing a variable');
  assert(/Choose variable/.test(releasedEl.querySelector('.fld-name').textContent),
    'and says so');

  // duplicating a field keeps both the variable and the value
  fld.varId = T.findVariableByName('Attack').id;
  fld.value = '12';
  T.renderItems();
  const fldCopy = T.duplicateItem(fld);
  assert(fldCopy.varId === fld.varId, 'copy points at the same variable');
  assert(fldCopy.value === '12', 'copy carries the value across');
  fldCopy.value = '99';
  assert(fld.value === '12', 'and the two values are independent afterwards');

  // the prompt modal returns text
  const promptOk = T.promptText({ title: 'Rename variable', body: 'x', value: 'Attack' });
  assert(el('#modalInput').hidden === false, 'prompt shows a text input');
  el('#modalInput').value = 'Power';
  el('#modalOk').click();
  assert((await promptOk) === 'Power', 'prompt resolves the typed text');

  const promptCancel = T.promptText({ title: 'Rename', body: 'x', value: 'Attack' });
  el('#modalCancel').click();
  assert((await promptCancel) === null, 'cancelling a prompt resolves null');

  // =========================================================================
  group('duplicating board items');
  T.goToPage(homePageId);
  await tick(10);
  const dupPage = T.activePage();

  // a plain card, via Ctrl+D
  T.setTool('card');
  pointer('pointerdown', el('#stage'), { clientX: 200, clientY: 700 });
  const orig = dupPage.items[dupPage.items.length - 1];
  orig.text = 'copy me';
  orig.color = '#c8402f';
  // A new card opens its editor on the next animation frame; let that land
  // before closing it, or it reopens mid-test and steals the selection.
  await tick(30);
  T.stopEditing();
  T.selectItem(orig.id);
  const nBefore = dupPage.items.length;

  key('d', { ctrlKey: true });
  await tick(10);
  assert(dupPage.items.length === nBefore + 1, 'Ctrl+D made a copy');
  const cardCopy = dupPage.items[dupPage.items.length - 1];
  assert(cardCopy.id !== orig.id, 'the copy has its own id');
  assert(cardCopy.text === 'copy me', 'text carried over');
  assert(cardCopy.color === '#c8402f', 'colour carried over');
  assert(cardCopy.x === orig.x + 26 && cardCopy.y === orig.y + 26,
    'copy is offset so both are visible');
  assert(T.selectedItemId === cardCopy.id, 'the copy is selected afterwards');

  // editing the copy must not touch the original
  cardCopy.text = 'changed';
  assert(orig.text === 'copy me', 'the two are independent');

  // a column brings its whole nested subtree and its internal arrows
  T.setTool('column');
  pointer('pointerdown', el('#stage'), { clientX: 900, clientY: 700 });
  const outer = dupPage.items[dupPage.items.length - 1];
  outer.title = 'Kit';
  const kid = { id: 'kid1', type: 'card', parent: outer.id, order: 0, x: 0, y: 0, w: 200, text: 'inside', color: null };
  const kid2 = { id: 'kid2', type: 'checklist', parent: outer.id, order: 1, x: 0, y: 0, w: 200, rows: [T.newRow('todo')] };
  dupPage.items.push(kid, kid2);
  dupPage.links.push({ id: 'innerlink', from: 'kid1', to: 'kid2', color: '#000' });
  const outsideCard = dupPage.items.find(i => i.id === orig.id);
  dupPage.links.push({ id: 'outerlink', from: 'kid1', to: outsideCard.id, color: '#000' });
  T.renderItems();

  const linksBefore = dupPage.links.length;
  const colCopy = T.duplicateItem(outer);
  assert(!!colCopy && colCopy.type === 'column', 'column duplicated');
  const copiedKids = T.childrenOf(dupPage, colCopy.id);
  assert(copiedKids.length === 2, 'both children came along');
  assert(copiedKids.every(c => c.id !== 'kid1' && c.id !== 'kid2'), 'children got fresh ids');
  assert(copiedKids[0].text === 'inside', 'child content preserved');
  assert(copiedKids[1].rows[0].text === 'todo', 'checklist rows preserved');
  assert(T.childrenOf(dupPage, outer.id).length === 2, 'the original column still has its children');

  assert(dupPage.links.length === linksBefore + 1, 'exactly one arrow was copied');
  const newLink = dupPage.links[dupPage.links.length - 1];
  assert(copiedKids.some(c => c.id === newLink.from) && copiedKids.some(c => c.id === newLink.to),
    'the copied arrow connects the copies, not the originals');

  // duplicating inside a column inserts right after the original
  const dupKid = T.duplicateItem(copiedKids[0]);
  const afterKids = T.childrenOf(dupPage, colCopy.id);
  assert(afterKids.length === 3, 'copy landed in the same column');
  assert(afterKids[1].id === dupKid.id, 'directly after the item it copied');
  assert(afterKids.every((c, i) => c.order === i), 'sibling order renumbered cleanly');

  // shared image files survive one copy being deleted
  const imgA = { id: 'imgA', type: 'image', x: 0, y: 0, w: 200, h: 100, src: 'inknote-img://local/shared.png' };
  dupPage.items.push(imgA);
  T.renderItems();
  const imgB = T.duplicateItem(imgA);
  assert(imgB.src === imgA.src, 'both boxes point at the same file');
  assert(T.imageStillUsed(imgA.src, ['imgA']) === true,
    'the file is still in use when only one copy is removed');
  assert(T.imageStillUsed(imgA.src, ['imgA', imgB.id]) === false,
    'and free once both are gone');

  // right-click menu on a board item
  el(`#items [data-id="${orig.id}"]`).dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 200, clientY: 700
  }));
  const itemMenu = el('#ctxMenu');
  assert(itemMenu.hidden === false, 'right-clicking a box opens a menu');
  const itemLabels = Array.from(itemMenu.querySelectorAll('.ctx-item')).map(b => b.textContent);
  assert(itemLabels.includes('Duplicate'), 'menu offers Duplicate');
  assert(itemLabels.includes('Edit text'), 'menu offers Edit text for a card');
  assert(itemLabels.includes('Bring to front'), 'menu offers Bring to front');
  assert(itemLabels.includes('Delete'), 'menu offers Delete');
  key('Escape');
  await tick(5);

  // bring to front moves it last in paint order
  T.bringToFront(orig);
  assert(dupPage.items[dupPage.items.length - 1].id === orig.id, 'item moved to the front');

  // Ctrl+D while typing is ignored
  T.selectItem(orig.id);
  T.beginEdit(orig.id);
  const beforeTyping = dupPage.items.length;
  key('d', { ctrlKey: true });
  assert(dupPage.items.length === beforeTyping, 'Ctrl+D does nothing mid-edit');
  T.stopEditing();

  // =========================================================================
  group('delete confirmation');
  const before = page.items.length;
  const targetEl = el(`#items [data-id="${target.id}"]`);
  targetEl.querySelector('.kill').click();
  await tick(10);
  assert(el('#modalBackdrop').hidden === false, 'confirmation modal opens for a non-empty card');
  assert(/target/.test(el('#modalBody').textContent), 'modal quotes the card text');

  el('#modalCancel').click();
  await tick(10);
  assert(el('#modalBackdrop').hidden === true, 'cancel closes the modal');
  assert(page.items.length === before, 'cancel kept the card');

  targetEl.querySelector('.kill').click();
  await tick(10);
  el('#modalOk').click();
  await tick(10);
  assert(page.items.length === before - 1, 'confirming deleted the card');
  assert(!page.links.some(l => l.from === target.id || l.to === target.id),
    'arrows attached to a deleted item are cleaned up');

  // deleting a column warns about its children
  // :scope > so we get the column's own delete button, not a child card's
  el(`#items [data-id="${col.id}"]`).querySelector(':scope > .kill').click();
  await tick(10);
  const kidCount = T.descendantIds(col.id).size - 1; // counts nested items too
  assert(new RegExp(`${kidCount} items`).test(el('#modalBody').textContent),
    'column warning counts everything inside it');
  el('#modalCancel').click();
  await tick(10);
  assert(T.descendantIds(col.id).size - 1 === kidCount, 'cancelled column delete kept its contents');

  // =========================================================================
  group('Delete key and Escape');
  T.setTool('card');
  pointer('pointerdown', stage, { clientX: 950, clientY: 220 });
  const doomed = page.items[page.items.length - 1];
  doomed.text = 'delete me';
  T.selectItem(doomed.id);
  const countBefore = page.items.length;

  key('Delete');
  await tick(10);
  assert(el('#modalBackdrop').hidden === false, 'Delete key asks before removing a filled card');
  el('#modalOk').click();
  await tick(10);
  assert(page.items.length === countBefore - 1, 'Delete key removed the selected card');

  T.setTool('pen');
  key('Escape');
  assert(T.toolName === 'select', 'Escape returns to the select tool');

  T.setTool('card');
  pointer('pointerdown', stage, { clientX: 980, clientY: 300 });
  const editing = page.items[page.items.length - 1];
  editing.text = 'still here';
  T.beginEdit(editing.id);
  key('Escape');
  assert(T.editingItemId === null, 'Escape closes an open editor');
  assert(T.toolName === 'select', 'Escape also falls back to select');
  assert(!!T.itemById(editing.id), 'Escape did not delete the card being edited');

  // =========================================================================
  group('section & page delete confirmation');
  el('#addSection').click();
  await tick(10);
  assert(all('#sectionList li').length === 2, 'section added');
  all('#sectionList li')[0].querySelector('.del').click();
  await tick(10);
  assert(el('#modalBackdrop').hidden === false, 'deleting a section asks first');
  assert(/Old Section/.test(el('#modalBody').textContent), 'modal names the section');
  el('#modalCancel').click();
  await tick(10);
  assert(T.notebook.sections.length === 2, 'cancel kept the section');

  el('#addPage').click();
  await tick(10);
  all('#pageList li')[0].querySelector('.del').click();
  await tick(10);
  assert(el('#modalBackdrop').hidden === false, 'deleting a page asks first');
  el('#modalOk').click();
  await tick(10);
  assert(all('#pageList li').length === 1, 'confirmed page delete removed it');

  // last-one guard
  all('#pageList li')[0].querySelector('.del').click();
  await tick(10);
  assert(/last page/.test(el('#modalBody').textContent), 'refuses to delete the final page');
  el('#modalOk').click();
  await tick(10);

  // =========================================================================
  group('sidebar: rename, reorder, context menu');
  all('#sectionList li')[0].click();
  await tick(10);
  const sec0 = T.activeSection();

  // three pages to shuffle
  while (sec0.pages.length < 3) { el('#addPage').click(); await tick(5); }
  sec0.pages[0].title = 'Alpha';
  sec0.pages[1].title = 'Beta';
  sec0.pages[2].title = 'Gamma';
  T.renderItems();

  // reorder: move the last page to the front
  const order = () => T.activeSection().pages.map(p => p.title).join(',');
  assert(order() === 'Alpha,Beta,Gamma', 'starting page order');
  assert(T.reorderById(sec0.pages, sec0.pages[2].id, sec0.pages[0].id, false) === true,
    'reorder reports a change');
  assert(order() === 'Gamma,Alpha,Beta', 'page moved to the front');

  // moving something onto itself is a no-op, not a dirty write
  assert(T.reorderById(sec0.pages, sec0.pages[0].id, sec0.pages[0].id, false) === false,
    'dropping a row on itself changes nothing');

  // rows advertise themselves as draggable and carry their identity
  const rowEls = all('#pageList li');
  assert(rowEls[0].draggable === true, 'page rows are draggable');
  assert(rowEls[0].dataset.kind === 'page' && !!rowEls[0].dataset.id, 'rows carry kind and id');
  assert(all('#sectionList li')[0].dataset.kind === 'section', 'section rows tagged too');

  // --- double-click rename: the real gesture, through the DOM -------------
  // Regression: selecting a row re-renders the list, so a listener bound to
  // the row itself was dead by the time the second click arrived.
  const dbl = (node) => node.dispatchEvent(
    new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  const clickRow = (node) => node.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  // an unselected row: click to select, then double-click the fresh element
  clickRow(all('#pageList li')[1]);
  await tick(10);
  const renameRow = all('#pageList li')[1];
  dbl(renameRow.querySelector('.label'));
  assert(renameRow.querySelector('.label').contentEditable === 'true',
    'double-click after selecting opens the rename field');
  assert(renameRow.draggable === false, 'the row stops being draggable while renaming');

  // committing writes through to the model
  const renamed = T.findPage(renameRow.dataset.id).page;
  renameRow.querySelector('.label').textContent = 'Renamed By Dblclick';
  renameRow.querySelector('.label').dispatchEvent(
    new window.FocusEvent('blur', { bubbles: false }));
  await tick(10);
  assert(renamed.title === 'Renamed By Dblclick', 'the new name is saved');

  // the already-selected row works too
  const activeRow = el('#pageList li.active');
  dbl(activeRow.querySelector('.label'));
  assert(activeRow.querySelector('.label').contentEditable === 'true',
    'double-click works on the row already open');
  key('Escape');
  await tick(5);

  // sections rename the same way
  const secRow = all('#sectionList li')[0];
  dbl(secRow.querySelector('.label'));
  assert(secRow.querySelector('.label').contentEditable === 'true',
    'sections rename by double-click as well');
  key('Escape');
  await tick(5);

  // right-click opens a menu with the expected actions
  rowEls[0].dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 40, clientY: 90
  }));
  const menu = el('#ctxMenu');
  assert(menu.hidden === false, 'right-click opens the context menu');
  const labels = Array.from(menu.querySelectorAll('.ctx-item')).map(b => b.textContent);
  assert(labels.includes('Rename'), 'menu offers Rename');
  assert(labels.includes('Duplicate'), 'menu offers Duplicate');
  assert(labels.some(l => /Delete page/.test(l)), 'menu offers Delete');
  assert(!!menu.querySelector('.ctx-item.danger'), 'the delete action is styled as destructive');

  key('Escape');
  assert(menu.hidden === true, 'Escape closes the menu');

  // duplicate makes an independent copy with remapped ids
  const src = T.activeSection().pages[0];
  src.items = [
    { id: 'a1', type: 'card', x: 0, y: 0, w: 200, text: 'one', color: null },
    { id: 'a2', type: 'card', x: 0, y: 90, w: 200, text: 'two', color: null }
  ];
  src.links = [{ id: 'l1', from: 'a1', to: 'a2', color: '#000' }];
  const pagesBefore = T.activeSection().pages.length;
  T.duplicatePage(T.activeSection(), src);
  await tick(10);
  const copy = T.activeSection().pages[1];
  assert(T.activeSection().pages.length === pagesBefore + 1, 'duplicate added a page');
  assert(copy.title === src.title + ' copy', 'copy is named clearly');
  assert(copy.items[0].id !== 'a1', 'copied items got fresh ids');
  assert(copy.links[0].from === copy.items[0].id && copy.links[0].to === copy.items[1].id,
    'arrows remapped onto the copied items');
  assert(src.items[0].id === 'a1', 'the original is untouched');

  // moving a page between sections
  const secA = T.notebook.sections[0];
  const secB = T.notebook.sections[1];
  const mover = secA.pages[secA.pages.length - 1];
  const bCount = secB.pages.length;
  T.movePageToSection(mover.id, secB);
  await tick(10);
  assert(secB.pages.length === bCount + 1, 'page landed in the other section');
  assert(!secA.pages.some(p => p.id === mover.id), 'and left the old one');
  assert(T.notebook.activePageId === mover.id, 'the moved page is now open');

  // the last page of a section can't be dragged away
  const lonely = T.notebook.sections.find(s => s.pages.length === 1);
  if (lonely) {
    T.movePageToSection(lonely.pages[0].id, secB);
    assert(lonely.pages.length === 1, 'a section is never left with no pages');
  }

  // =========================================================================
  group('undo / redo with items');
  all('#sectionList li')[0].click();
  await tick(10);
  const pg = T.activePage();
  const n = pg.items.length;
  T.setTool('card');
  pointer('pointerdown', el('#stage'), { clientX: 60, clientY: 60 });
  assert(pg.items.length === n + 1, 'card added on the original page');
  el('#undoBtn').click();
  assert(T.activePage().items.length === n, 'undo removed the new card');
  el('#redoBtn').click();
  assert(T.activePage().items.length === n + 1, 'redo restored it');

  // =========================================================================
  group('a field can host a box as its value');
  {
    const fpage = T.activePage();
    T.setTool('field');
    pointer('pointerdown', el('#stage'), { clientX: 80, clientY: 1200 });
    const host = fpage.items[fpage.items.length - 1];
    await tick(30);
    T.closeVariablePicker();
    host.varId = T.createVariable('Weapon').id;
    host.value = 'typed value';
    T.renderItems();

    let hostEl = elFor(host.id);
    assert(!!hostEl.querySelector('.fld-slot'), 'the value half is a slot');
    assert(!!hostEl.querySelector('.fld-value'), 'which holds a text field by default');
    assert(!hostEl.classList.contains('has-child'), 'and hosts nothing yet');

    // an empty field advertises itself as a drop target
    const slot = hostEl.querySelector('.fld-slot');
    const sr = slot.getBoundingClientRect();
    const scx = sr.left + sr.width / 2;
    const scy = sr.top + sr.height / 2;
    assert(T.columnUnder(scx, scy, null) === host, 'an empty field accepts a drop');

    // drop a link box into it
    const guest = { id: 'guest1', type: 'link', x: 900, y: 1200, w: 240,
                    target: otherPage.id, anchor: null, label: 'Sword of X' };
    fpage.items.push(guest);
    T.renderItems();
    assert(T.dropIntoColumn(guest, host, { x: scx, y: scy }) === true, 'the drop was accepted');
    T.renderItems();

    assert(guest.parent === host.id, 'the link box is parented to the field');
    hostEl = elFor(host.id);
    assert(hostEl.classList.contains('has-child'), 'the field knows it is hosting');
    assert(!!hostEl.querySelector('.fld-slot [data-id="guest1"]'),
      'the box renders inside the value slot');
    assert(!hostEl.querySelector('.fld-value'), 'the text field steps aside');
    assert(hostEl.style.width === '', 'the field drops its fixed width so it can fit the box');

    // the typed value is kept, not thrown away
    assert(host.value === 'typed value', 'the previously typed value is preserved');

    // a full field stops accepting drops
    assert(T.columnUnder(scx, scy, null) !== host, 'a filled field is no longer a drop target');

    // it counts as part of the field for deletes and copies
    assert(T.descendantIds(host.id).has('guest1'), 'the box is part of the field subtree');
    const hostCopy = T.duplicateItem(host);
    const copyKid = T.fieldChild(hostCopy);
    assert(!!copyKid && copyKid.id !== 'guest1', 'duplicating the field copies the hosted box');
    assert(copyKid.label === 'Sword of X', 'with its contents');

    // taking it back out
    T.detachFieldChild(host);
    assert(guest.parent === null, 'the box is free again');
    assert(!T.fieldChild(host), 'the field no longer hosts anything');
    hostEl = elFor(host.id);
    assert(!!hostEl.querySelector('.fld-value'), 'the text field comes back');
    assert(hostEl.querySelector('.fld-value').textContent === 'typed value',
      'showing the value that was there all along');

    // deleting a field takes its hosted box with it
    T.dropIntoColumn(guest, host, { x: scx, y: scy });
    T.renderItems();
    T.selectItem(host.id);
    elFor(host.id).querySelector(':scope > .kill').click();
    await tick(10);
    assert(/box inside it/.test(el('#modalBody').textContent),
      'the delete warning mentions the hosted box');
    el('#modalOk').click();
    await tick(10);
    assert(!fpage.items.some(i => i.id === 'guest1'), 'the hosted box went with it');
  }

  // =========================================================================
  group('rows lay boxes side by side');
  {
    const rpage = T.activePage();
    T.setTool('row');
    pointer('pointerdown', el('#stage'), { clientX: 60, clientY: 900 });
    const row = rpage.items[rpage.items.length - 1];
    assert(row.type === 'row', 'row tool placed a row');
    assert(row.w === undefined, 'a row carries no width — it fits its contents');
    assert(row.title === 'Row', 'named for what it is');

    const rowEl = el(`#items [data-id="${row.id}"]`);
    assert(rowEl.classList.contains('rowbox'), 'element is marked as horizontal');
    assert(rowEl.classList.contains('column'), 'but reuses the container chrome');
    assert(!!rowEl.querySelector('.col-body'), 'it has a drop body');
    assert(!!rowEl.querySelector('.col-toggle'), 'and collapses like a column');
    assert(!rowEl.querySelector('.resize'), 'no resize handle — it auto-fits');

    // a row can be renamed like a column
    T.beginEdit(row.id);
    const rowHead = elFor(row.id).querySelector(':scope > .col-bar > .col-head');
    assert(rowHead.contentEditable === 'true', 'double-clicking a row header opens it for renaming');
    rowHead.textContent = 'Moves';
    rowHead.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert(row.title === 'Moves', 'the new row name is saved');
    T.stopEditing();

    // Build three cards inside it by clicking with a tool. The body has to be
    // re-queried each time: creating an item re-renders and the old node dies.
    for (let i = 0; i < 3; i++) {
      T.setTool('card');
      const body = elFor(row.id).querySelector(':scope > .col-body');
      pointer('pointerdown', body, { clientX: 100 + i * 10, clientY: 910 });
      await tick(30);
      // Give it text before closing the editor — an empty card is treated as
      // a misclick and removed, which is correct behaviour.
      rpage.items[rpage.items.length - 1].text = `col ${i + 1}`;
      T.stopEditing();
    }
    const kidsInRow = T.childrenOf(rpage, row.id);
    assert(kidsInRow.length === 3, 'three cards landed inside the row');
    assert(/3 items/.test(elFor(row.id).querySelector('.col-count').textContent),
      'the row header counts its own boxes');
    assert(kidsInRow.every(k => k.parent === row.id), 'all parented to it');

    // ordering across a row is decided by X, not Y
    const loose = { id: 'rl', type: 'card', x: 0, y: 0, w: 200, text: 'inserted', color: null };
    rpage.items.push(loose);
    T.renderItems();
    const firstKidEl = elFor(kidsInRow[0].id);
    const r0 = firstKidEl.getBoundingClientRect();
    T.dropIntoColumn(loose, row, { x: r0.left - 5, y: 99999 });
    const reordered = T.childrenOf(rpage, row.id);
    assert(reordered.length === 4, 'the loose card joined the row');
    assert(reordered[0].id === 'rl',
      'dropping left of the first card puts it first — a row orders by X, not Y');

    // and a column still orders by Y even with a wild X
    T.setTool('column');
    pointer('pointerdown', el('#stage'), { clientX: 700, clientY: 900 });
    const colForY = rpage.items[rpage.items.length - 1];
    const seedA = { id: 'ry1', type: 'card', parent: colForY.id, order: 0, x: 0, y: 0, w: 200, text: 'a', color: null };
    const seedB = { id: 'ry2', type: 'card', parent: colForY.id, order: 1, x: 0, y: 0, w: 200, text: 'b', color: null };
    const loose2 = { id: 'rl2', type: 'card', x: 0, y: 0, w: 200, text: 'y test', color: null };
    rpage.items.push(seedA, seedB, loose2);
    T.renderItems();
    T.dropIntoColumn(loose2, colForY, { x: -99999, y: 99999 });
    const colKids = T.childrenOf(rpage, colForY.id);
    assert(colKids.length === 3, 'the column took the card');
    assert(colKids[colKids.length - 1].id === 'rl2',
      'a column still uses Y — a far-left X does not send it to the front');

    // rows nest inside columns and vice versa
    const inner = T.addRow(0, 0);
    T.dropIntoColumn(inner, row, { x: 99999, y: 0 });
    T.renderItems();
    assert(inner.parent === row.id, 'a row nests inside a row');
    assert(!!el(`#items [data-id="${row.id}"] .col-body [data-id="${inner.id}"]`),
      'and renders inside it');
    assert(T.isContainer(inner) && T.isContainer(row), 'both count as containers');

    // deleting names the right kind of thing
    T.selectItem(row.id);
    el(`#items [data-id="${row.id}"]`).querySelector(':scope > .kill').click();
    await tick(10);
    assert(/the row/.test(el('#modalBody').textContent),
      'the delete confirmation calls it a row, not a column');
    el('#modalCancel').click();
    await tick(10);
  }

  // =========================================================================
  group('collapsing columns');
  {
    const cpage = T.activePage();
    T.setTool('column');
    pointer('pointerdown', el('#stage'), { clientX: 100, clientY: 100 });
    const folder = cpage.items[cpage.items.length - 1];
    folder.title = 'Stats';
    const a = { id: 'fa', type: 'card', parent: folder.id, order: 0, x: 0, y: 0, w: 200, text: 'hp', color: null };
    const b = { id: 'fb', type: 'card', parent: folder.id, order: 1, x: 0, y: 0, w: 200, text: 'atk', color: null };
    cpage.items.push(a, b);
    cpage.links.push({ id: 'flink', from: 'fa', to: 'fb', color: '#000' });
    T.renderItems();

    let fEl = el(`#items [data-id="${folder.id}"]`);
    assert(!!fEl.querySelector('.col-toggle'), 'the column has a collapse button');
    assert(fEl.querySelector('.col-toggle').textContent === '\u2212',
      'it shows a minus while expanded');
    assert(/2 items/.test(fEl.querySelector('.col-count').textContent),
      'the header counts what is inside');
    assert(!fEl.classList.contains('collapsed'), 'starts expanded');

    // collapse it
    fEl.querySelector('.col-toggle').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await tick(10);
    assert(folder.collapsed === true, 'model records the collapse');
    fEl = el(`#items [data-id="${folder.id}"]`);
    assert(fEl.classList.contains('collapsed'), 'element shows as collapsed');
    assert(fEl.querySelector('.col-toggle').textContent === '+', 'button flips to a plus');
    assert(fEl.querySelector('.col-toggle').getAttribute('aria-expanded') === 'false',
      'and reports its state for screen readers');

    // the children are still in the model, just hidden
    assert(T.childrenOf(cpage, folder.id).length === 2, 'children are kept, not discarded');

    // arrows into a folded column attach to the column itself
    assert(T.linkEndpointEl('fa') === fEl,
      'an arrow endpoint inside a collapsed column resolves to the column');

    // a collapsed column refuses drops: aim at its own centre and check
    const box = fEl.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    assert(T.columnUnder(cx, cy, null) === null,
      'a collapsed column is not a drop target');

    // expand again
    fEl.querySelector('.col-toggle').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await tick(10);
    assert(folder.collapsed === false, 'toggles back open');
    const openBox = el(`#items [data-id="${folder.id}"]`).getBoundingClientRect();
    assert(T.columnUnder(openBox.left + openBox.width / 2,
                         openBox.top + openBox.height / 2, null) === folder,
      'and accepts drops again once expanded');
    assert(T.linkEndpointEl('fa') === el('#items [data-id="fa"]'),
      'arrows go back to the card itself');

    // revealing something buried in a collapsed column opens it first
    folder.collapsed = true;
    T.renderItems();
    assert(T.expandAncestors('fa') === true, 'revealing expands the containers above it');
    assert(folder.collapsed === false, 'the column was opened');

    // nested: collapsing an outer column hides the inner one too
    const outerId = folder.id;
    const nested = { id: 'fn', type: 'column', parent: outerId, order: 2, x: 0, y: 0, w: 200, title: 'Sub' };
    const deep = { id: 'fd', type: 'card', parent: 'fn', order: 0, x: 0, y: 0, w: 180, text: 'deep', color: null };
    cpage.items.push(nested, deep);
    T.renderItems();
    fEl = el(`#items [data-id="${outerId}"]`);
    assert(/3 items/.test(fEl.querySelector('.col-count').textContent),
      'the count is direct children only — the nested card is counted on its own header');
    assert(/1 item/.test(elFor('fn').querySelector('.col-count').textContent),
      'and the inner column reports its own single child');
    T.toggleColumn(folder);
    assert(T.linkEndpointEl('fd') === el(`#items [data-id="${outerId}"]`),
      'a deeply nested endpoint resolves to the outermost collapsed column');
    assert(T.expandAncestors('fd') === true, 'and expanding walks the whole chain');

    // the menu offers it too
    T.renderItems();
    el(`#items [data-id="${outerId}"]`).dispatchEvent(new window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 100, clientY: 100
    }));
    const colLabels = Array.from(el('#ctxMenu').querySelectorAll('.ctx-item')).map(x => x.textContent);
    assert(colLabels.includes('Collapse') || colLabels.includes('Expand'),
      'the right-click menu offers collapse/expand');
    key('Escape');
    await tick(5);
  }

  // =========================================================================
  group('copy & paste');
  {
    const src = T.activePage();
    T.setTool('column');
    pointer('pointerdown', el('#stage'), { clientX: 300, clientY: 300 });
    const box = src.items[src.items.length - 1];
    box.title = 'Loadout';
    const inner = { id: 'cp1', type: 'card', parent: box.id, order: 0,
                    x: 0, y: 0, w: 200, text: 'sword', color: '#1f8a52' };
    const inner2 = { id: 'cp2', type: 'card', parent: box.id, order: 1,
                     x: 0, y: 0, w: 200, text: 'shield', color: null };
    src.items.push(inner, inner2);
    src.links.push({ id: 'cplink', from: 'cp1', to: 'cp2', color: '#000' });
    T.renderItems();

    assert(T.copyItem(box) === true, 'copy captured the box');
    assert(T.boardClipboard.items.length === 3, 'clipboard holds the column and both cards');
    assert(T.boardClipboard.links.length === 1, 'and the arrow between them');

    // paste onto the same page
    const nBefore = src.items.length;
    const pasted = T.pasteClipboard({ x: 1500, y: 1500 });
    assert(src.items.length === nBefore + 3, 'paste added the whole subtree');
    assert(pasted.id !== box.id, 'the pasted root is a new item');
    assert(pasted.title === 'Loadout', 'title carried across');
    assert(pasted.x === 1500 && pasted.y === 1500, 'it landed where asked');
    const pastedKids = T.childrenOf(src, pasted.id);
    assert(pastedKids.length === 2, 'children came along');
    assert(pastedKids[0].text === 'sword' && pastedKids[0].color === '#1f8a52',
      'child content and colour preserved');
    assert(T.childrenOf(src, box.id).length === 2, 'the original is untouched');

    const copiedLink = src.links[src.links.length - 1];
    assert(pastedKids.some(k => k.id === copiedLink.from) &&
           pastedKids.some(k => k.id === copiedLink.to),
      'the arrow was recreated between the pasted cards');

    // the clipboard survives to be pasted again
    const again = T.pasteClipboard({ x: 60, y: 60 });
    assert(!!again && again.id !== pasted.id, 'the same clipboard pastes more than once');

    // ...and onto a different page entirely
    el('#addPage').click();
    await tick(10);
    const otherBoard = T.activePage();
    assert(otherBoard.items.length === 0, 'the new page starts empty');
    const crossed = T.pasteClipboard({ x: 200, y: 200 });
    assert(otherBoard.items.length === 3, 'pasted onto a different page');
    assert(crossed.title === 'Loadout', 'with its contents intact');
    assert(T.childrenOf(otherBoard, crossed.id).length === 2, 'and its children');
    assert(otherBoard.links.length === 1, 'and its internal arrow');

    // copying an item that sits inside a column pastes it free-standing
    T.copyItem(T.childrenOf(otherBoard, crossed.id)[0]);
    const freed = T.pasteClipboard({ x: 700, y: 90 });
    assert(freed.parent === null, 'a copied child pastes as a free box');
    assert(freed.text === 'sword', 'with its text');

    // the blank-board menu offers Paste
    el('#stage').dispatchEvent(new window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 500, clientY: 500
    }));
    const boardMenu = el('#ctxMenu');
    assert(boardMenu.hidden === false, 'right-clicking blank board opens a menu');
    const boardLabels = Array.from(boardMenu.querySelectorAll('.ctx-item')).map(b => b.textContent);
    assert(boardLabels.includes('Paste here'), 'menu offers Paste here');
    assert(boardLabels.includes('New card here'), 'and quick creation');
    key('Escape');
    await tick(5);

    // an item's own menu offers Copy
    T.renderItems();
    el(`#items [data-id="${crossed.id}"]`).dispatchEvent(new window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 200, clientY: 200
    }));
    const itemLabels2 = Array.from(el('#ctxMenu').querySelectorAll('.ctx-item')).map(b => b.textContent);
    assert(itemLabels2.includes('Copy'), 'item menu offers Copy');
    key('Escape');
    await tick(5);
  }

  // =========================================================================
  group('multi-select');
  {
    el('#addPage').click();
    await tick(10);
    const mp = T.activePage();
    const mk = (id, x, y, text) => ({ id, type: 'card', x, y, w: 200, text, color: null });
    mp.items.push(mk('m1', 100, 100, 'one'), mk('m2', 400, 100, 'two'), mk('m3', 700, 100, 'three'));
    T.renderItems();

    const ctrlDown = (id) => {
      const ev = new window.MouseEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 0, ctrlKey: true
      });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      elFor(id).dispatchEvent(ev);
    };

    T.selectItem('m1');
    assert(T.selection.size === 1, 'a plain click selects one');

    ctrlDown('m2');
    ctrlDown('m3');
    assert(T.selection.size === 3, 'ctrl-click adds to the selection');
    assert(elFor('m2').classList.contains('selected'), 'each one is marked');
    assert(/3 selected/.test(el('#selectionLabel').textContent), 'the status bar shows the count');

    ctrlDown('m3');
    assert(T.selection.size === 2, 'ctrl-clicking again removes it');
    ctrlDown('m3');

    // a plain click on blank board clears; ctrl-click on blank keeps
    T.setTool('select');
    pointer('pointerdown', el('#stage'), { clientX: 5, clientY: 5, ctrlKey: true });
    assert(T.selection.size === 3, 'ctrl-clicking blank board keeps the selection');
    pointer('pointerdown', el('#stage'), { clientX: 5, clientY: 5 });
    assert(T.selection.size === 0, 'a plain click on blank board clears it');

    // rebuild the selection
    T.selectItem('m1'); T.toggleSelect('m2'); T.toggleSelect('m3');

    // roots: a selected child inside a selected container is not a root
    const holder = { id: 'mc', type: 'column', x: 1000, y: 100, w: 300, title: 'Box' };
    const inside = { id: 'mi', type: 'card', parent: 'mc', order: 0, x: 0, y: 0, w: 200, text: 'in', color: null };
    mp.items.push(holder, inside);
    T.renderItems();
    T.toggleSelect('mc'); T.toggleSelect('mi');
    assert(T.selection.size === 5, 'five things selected');
    assert(T.selectionRoots().length === 4,
      'the card inside a selected column is not counted separately');
    T.toggleSelect('mi'); T.toggleSelect('mc');

    // duplicate the group
    const beforeDup = mp.items.length;
    key('d', { ctrlKey: true });
    await tick(10);
    assert(mp.items.length === beforeDup + 3, 'Ctrl+D duplicated all three');
    assert(T.selection.size === 3, 'the copies are what stays selected');
    assert(![...T.selection].includes('m1'), 'and the originals are deselected');

    // delete the group with one confirmation
    const beforeDel = mp.items.length;
    key('Delete');
    await tick(10);
    assert(el('#modalBackdrop').hidden === false, 'deleting a group asks once');
    assert(/3 boxes/.test(el('#modalBody').textContent), 'and says how many');
    el('#modalOk').click();
    await tick(10);
    assert(mp.items.length === beforeDel - 3, 'all three went');

    // copy and paste a group, keeping the relative layout
    T.selectItem('m1'); T.toggleSelect('m2'); T.toggleSelect('m3');
    assert(T.copySelection() === true, 'copied the selection');
    assert(T.boardClipboard.rootIds.length === 3, 'clipboard holds three roots');

    const beforePaste = mp.items.length;
    T.pasteClipboard({ x: 2000, y: 2000 });
    assert(mp.items.length === beforePaste + 3, 'all three pasted');
    const pasted = mp.items.slice(-3);
    assert(pasted[0].x === 2000 && pasted[0].y === 2000, 'the group anchors at the paste point');
    assert(pasted[1].x === 2300, 'and the others keep their offsets');
    assert(pasted[2].x === 2600, 'across the whole group');

    // colour applies to everything selected
    T.selectItem('m1'); T.toggleSelect('m2');
    all('#colorRow .swatch-btn')[3].click();
    assert(T.itemById('m1').color === '#1f8a52' && T.itemById('m2').color === '#1f8a52',
      'a swatch recolours every selected box');

    // dragging one member moves the group
    T.selectItem('m1'); T.toggleSelect('m2');
    const startX = T.itemById('m2').x;
    const down = new window.MouseEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 100, clientY: 100, button: 0
    });
    Object.defineProperty(down, 'pointerId', { value: 1 });
    elFor('m1').dispatchEvent(down);
    pointer('pointermove', el('#stage'), { clientX: 160, clientY: 100 });
    pointer('pointerup', el('#stage'), { clientX: 160, clientY: 100 });
    assert(T.itemById('m2').x === startX + 60, 'the other selected box moved by the same amount');

    // ---- dropping a group into a container ------------------------------
    const target = { id: 'mt', type: 'column', x: 3000, y: 100, w: 320, title: 'Landing' };
    mp.items.push(target);
    T.renderItems();

    // three loose cards, stacked top to bottom out of click order
    const a = T.itemById('m1'), b = T.itemById('m2'), c = T.itemById('m3');
    a.parent = null; b.parent = null; c.parent = null;
    a.x = 100; a.y = 300;   // visually second
    b.x = 100; b.y = 100;   // visually first
    c.x = 100; c.y = 500;   // visually third
    T.renderItems();

    // click them in a deliberately different order
    T.selectItem('m3'); T.toggleSelect('m1'); T.toggleSelect('m2');
    const ordered = T.orderForDrop([c, a, b], target);
    assert(ordered.map(i => i.id).join() === 'm2,m1,m3',
      'loose boxes land in the order they read on the board, not the click order');

    T.dropManyIntoColumn(ordered, target, null);
    const landed = T.childrenOf(mp, 'mt');
    assert(landed.length === 3, 'all three went in together');
    assert(landed.map(i => i.id).join() === 'm2,m1,m3', 'and kept that order inside');
    assert(landed.every((i, idx) => i.order === idx), 'orders renumbered cleanly');

    // moving them on to a second container keeps the order they had
    const target2 = { id: 'mt2', type: 'column', x: 3400, y: 100, w: 320, title: 'Second' };
    mp.items.push(target2);
    T.renderItems();
    const again = T.orderForDrop(landed, target2);
    assert(again.map(i => i.id).join() === 'm2,m1,m3',
      'boxes from the same container keep the order they already had');
    T.dropManyIntoColumn(again, target2, null);
    assert(T.childrenOf(mp, 'mt2').map(i => i.id).join() === 'm2,m1,m3', 'order survived the move');
    assert(T.childrenOf(mp, 'mt').length === 0, 'and they left the first container');

    // a row orders left-to-right instead
    const rowTarget = { id: 'mtr', type: 'row', x: 3800, y: 100, title: 'Sideways' };
    mp.items.push(rowTarget);
    a.parent = null; b.parent = null; c.parent = null;
    a.x = 500; a.y = 0; b.x = 100; b.y = 0; c.x = 900; c.y = 0;
    T.renderItems();
    assert(T.orderForDrop([c, a, b], rowTarget).map(i => i.id).join() === 'm2,m1,m3',
      'a row orders by X');

    // mixed origins fall back to click order
    a.parent = 'mt'; a.order = 0;
    b.parent = null; c.parent = null;
    T.selectItem('m3'); T.toggleSelect('m1'); T.toggleSelect('m2');
    assert(T.orderForDrop([a, b, c], rowTarget).map(i => i.id).join() === 'm3,m1,m2',
      'a mixed group falls back to the order they were clicked');

    // a field still refuses a group — it only has one slot
    const oneSlot = { id: 'mf', type: 'field', x: 4200, y: 100, w: 300, varId: null, value: '' };
    mp.items.push(oneSlot);
    T.renderItems();
    assert(T.dropManyIntoColumn([b, c], oneSlot, null) === false,
      'a field will not take a group');
    assert(T.dropManyIntoColumn([b], oneSlot, null) === true, 'but still takes one');

    T.clearSelection();
    assert(el('#selectionLabel').textContent === '', 'the count clears with the selection');
  }

  // =========================================================================
  group('middle button only ever pans');
  {
    el('#addPage').click();
    await tick(10);
    const bp = T.activePage();
    bp.items.push({ id: 'mb1', type: 'card', x: 200, y: 200, w: 200, text: 'do not move me', color: null });
    T.renderItems();
    T.setTool('select');
    T.clearSelection();

    const boxEl = elFor('mb1');
    const startPos = { x: T.itemById('mb1').x, y: T.itemById('mb1').y };
    const startCam = { x: T.cam.x, y: T.cam.y };

    // middle-press directly on the box
    const mid = new window.MouseEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 300, clientY: 300, button: 1
    });
    Object.defineProperty(mid, 'pointerId', { value: 1 });
    boxEl.dispatchEvent(mid);

    assert(!!T.panning, 'middle-pressing a box starts a pan');
    assert(T.selection.size === 0, 'it does not select the box');

    pointer('pointermove', el('#stage'), { clientX: 250, clientY: 260 });
    assert(T.itemById('mb1').x === startPos.x && T.itemById('mb1').y === startPos.y,
      'the box has not moved');
    assert(T.cam.x !== startCam.x || T.cam.y !== startCam.y, 'the camera has');

    pointer('pointerup', el('#stage'), { clientX: 250, clientY: 260 });
    assert(!T.panning, 'releasing ends the pan');

    // the same press over a small control inside a box
    const holder = { id: 'mb2', type: 'column', x: 800, y: 200, w: 300, title: 'Grab me' };
    bp.items.push(holder);
    T.renderItems();
    const toggle = elFor('mb2').querySelector('.col-toggle');
    const mid2 = new window.MouseEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 810, clientY: 210, button: 1
    });
    Object.defineProperty(mid2, 'pointerId', { value: 1 });
    toggle.dispatchEvent(mid2);
    assert(!!T.panning, 'middle-pressing a control inside a box still pans');
    assert(T.itemById('mb2').collapsed !== true, 'and does not trigger the control');
    pointer('pointerup', el('#stage'), { clientX: 810, clientY: 210 });

    // right button leaves boxes alone too
    const rightDown = new window.MouseEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 300, clientY: 300, button: 2
    });
    Object.defineProperty(rightDown, 'pointerId', { value: 1 });
    T.clearSelection();
    elFor('mb1').dispatchEvent(rightDown);
    assert(!T.panning, 'right-pressing a box does not pan');
    assert(T.selection.size === 0, 'and does not start a drag-select');

    // left button still works normally
    const leftDown = new window.MouseEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 300, clientY: 300, button: 0
    });
    Object.defineProperty(leftDown, 'pointerId', { value: 1 });
    elFor('mb1').dispatchEvent(leftDown);
    assert(T.selection.has('mb1'), 'left-clicking a box still selects it');
    pointer('pointerup', el('#stage'), { clientX: 300, clientY: 300 });
  }

  // =========================================================================
  group('home / re-centre');
  // A page of its own so the bounds are predictable.
  el('#addPage').click();
  await tick(10);
  const homePage = T.activePage();
  homePage.items = [
    { id: 'h1', type: 'card', x: 1000, y: 800, w: 200, h: 120, text: 'far away', color: null },
    { id: 'h2', type: 'card', x: 1400, y: 1000, w: 200, h: 120, text: 'also far', color: null }
  ];
  T.renderItems();

  const bounds = T.contentBounds();
  assert(!!bounds, 'content bounds found');
  assert(bounds.x === 1000 && bounds.y === 800, 'bounds start at the top-left item');
  assert(bounds.w === 600 && bounds.h === 320, 'bounds span to the far corner of the last item');

  // strand the camera somewhere useless
  T.setTool('select');
  const framed = T.goHome({ animate: false });
  const view = el('#stage').getBoundingClientRect();
  const centreX = framed.x + view.width  / (2 * framed.scale);
  const centreY = framed.y + view.height / (2 * framed.scale);
  assert(Math.abs(centreX - (bounds.x + bounds.w / 2)) < 0.5, 'content is centred horizontally');
  assert(Math.abs(centreY - (bounds.y + bounds.h / 2)) < 0.5, 'content is centred vertically');
  assert(framed.scale <= 1, 'never zooms in past 100%');
  assert(framed.scale > 0.2, 'and stays readable');

  // content bigger than the window zooms out to fit
  homePage.items.push({ id: 'h3', type: 'card', x: 1000, y: 800, w: 4000, h: 3000, text: 'huge', color: null });
  T.renderItems();
  const zoomedOut = T.goHome({ animate: false });
  assert(zoomedOut.scale < 1, 'a board larger than the window zooms out to fit');

  // an empty page returns to the origin
  homePage.items = [];
  homePage.strokes = [];
  T.renderItems();
  const origin = T.goHome({ animate: false });
  assert(origin.x === -60 && origin.y === -60 && origin.scale === 1,
    'an empty page goes back to the origin');

  // ink counts as content too
  homePage.strokes = [{ id: 's9', tool: 'pen', color: '#000', size: 3,
                        points: [[500, 500, .5], [700, 640, .5]] }];
  const inkBounds = T.contentBounds();
  assert(inkBounds.x === 500 && inkBounds.w === 200, 'ink is included in the bounds');

  // the keybinding and the button both work
  T.goHome({ animate: false });
  const homeCam = { x: T.cam.x, y: T.cam.y };
  T.cam.x = 9999; T.cam.y = 9999;
  key('Home');
  await tick(400);
  assert(Math.abs(T.cam.x - homeCam.x) < 1 && Math.abs(T.cam.y - homeCam.y) < 1,
    'the Home key brings the camera back');

  T.cam.x = -9999; T.cam.y = -9999;
  el('#homeBtn').click();
  await tick(400);
  assert(Math.abs(T.cam.x - homeCam.x) < 1, 'the toolbar button does the same');

  // =========================================================================
  group('persistence');
  await tick(900);
  assert(saved !== null, 'auto-save fired');
  assert(saved.version === 2, 'saved in the v2 format');
  assert(JSON.stringify(saved).length > 0 && !/"texts"/.test(JSON.stringify(saved)),
    'no legacy texts arrays written back');

  console.log(failed ? `\nSMOKE TEST FAILED (${failed})` : '\nSMOKE TEST PASSED');
  if (failed) process.exitCode = 1;
})().catch(err => {
  console.error('\nTEST HARNESS ERROR:', err);
  process.exitCode = 1;
});
