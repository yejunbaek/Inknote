// Headless smoke test: boot the renderer against index.html in jsdom and
// exercise the main flows. Not shipped with the app.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'src', 'index.html'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

// --- stubs jsdom doesn't provide -------------------------------------------
const ctxStub = new Proxy({}, {
  get: (_t, k) => (k === 'canvas' ? {} : () => {})
});
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.PointerEvent = window.MouseEvent;
if (!window.Element.prototype.setPointerCapture) {
  window.Element.prototype.setPointerCapture = () => {};
  window.Element.prototype.releasePointerCapture = () => {};
}

let saved = null;
window.api = {
  load: async () => null,
  save: async (d) => { saved = d; return { ok: true }; },
  dataPath: async () => '/tmp/notebook.json',
  exportNotebook: async () => ({ ok: true }),
  importNotebook: async () => ({ ok: false, canceled: true })
};

const code = fs.readFileSync(path.join(__dirname, 'src', 'renderer.js'), 'utf8');
window.eval(code);

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('pass:', msg);
};

const doc = window.document;

function pointer(type, target, opts = {}) {
  const ev = new window.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 0, ...opts
  });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  Object.defineProperty(ev, 'pressure', { value: 0.5 });
  target.dispatchEvent(ev);
}

setTimeout(() => {
  const stage = doc.querySelector('#stage');

  assert(doc.querySelectorAll('#sectionList li').length === 1, 'one default section rendered');
  assert(doc.querySelectorAll('#pageList li').length === 1, 'one default page rendered');
  assert(doc.querySelector('.tool[data-tool="pen"]').classList.contains('active'), 'pen is the default tool');
  assert(doc.querySelectorAll('#colorRow .swatch-btn').length === 8, 'color swatches built');

  // --- draw a stroke ---
  pointer('pointerdown', stage, { clientX: 100, clientY: 100 });
  pointer('pointermove', stage, { clientX: 140, clientY: 130 });
  pointer('pointermove', stage, { clientX: 180, clientY: 90 });
  pointer('pointerup', stage, { clientX: 180, clientY: 90 });

  // --- add a page & a section ---
  doc.querySelector('#addPage').click();
  assert(doc.querySelectorAll('#pageList li').length === 2, 'adding a page works');
  doc.querySelector('#addSection').click();
  assert(doc.querySelectorAll('#sectionList li').length === 2, 'adding a section works');

  // --- text tool creates a box ---
  doc.querySelector('.tool[data-tool="text"]').click();
  pointer('pointerdown', stage, { clientX: 220, clientY: 200 });
  assert(doc.querySelectorAll('#overlay .textbox').length === 1, 'text tool creates a text box');

  // --- tool switching updates modes ---
  doc.querySelector('.tool[data-tool="highlighter"]').click();
  assert(doc.querySelector('#overlay').classList.contains('ink-mode'), 'ink tools set ink-mode');
  doc.querySelector('.tool[data-tool="select"]').click();
  assert(!doc.querySelector('#overlay').classList.contains('ink-mode'), 'select tool clears ink-mode');

  // --- zoom ---
  doc.querySelector('#zoomIn').click();
  assert(doc.querySelector('#zoomLevel').textContent === '120%', 'zoom in updates label');
  doc.querySelector('#zoomLevel').click();
  assert(doc.querySelector('#zoomLevel').textContent === '100%', 'zoom reset works');

  // --- undo on the first page restores the stroke count ---
  doc.querySelector('#sectionList li').click();
  doc.querySelector('#pageList li').click();
  setTimeout(() => {
    assert(saved !== null, 'auto-save fired');
    const sec0 = saved.sections[0];
    assert(sec0.pages[0].strokes.length === 1, 'stroke persisted to page 1');
    assert(sec0.pages[0].strokes[0].points.length >= 2, 'stroke captured multiple points');

    const undoBtn = doc.querySelector('#undoBtn');
    assert(!undoBtn.disabled, 'undo available on page 1');
    undoBtn.click();
    assert(sec0.pages[0].strokes.length === 0, 'undo removed the stroke');
    doc.querySelector('#redoBtn').click();
    assert(sec0.pages[0].strokes.length === 1, 'redo restored the stroke');

    console.log(process.exitCode ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
  }, 900);
}, 60);
