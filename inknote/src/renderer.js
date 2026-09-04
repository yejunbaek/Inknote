/* ==========================================================================
   InkNote — renderer
   --------------------------------------------------------------------------
   Data model
     notebook = { sections: [ Section ], activeSectionId, activePageId }
     Section  = { id, name, color, pages: [ Page ] }
     Page     = { id, title, strokes: [ Stroke ], texts: [ TextBox ] }
     Stroke   = { id, tool, color, size, points: [ [x, y, pressure] ] }
     TextBox  = { id, x, y, w, text }

   All ink/text coordinates are WORLD coordinates. The camera maps world to
   screen:  screen = (world - cam) * cam.scale
   ========================================================================== */

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const PALETTE = [
  '#23201c', // ink black
  '#1f5fd0', // blue
  '#c8402f', // red
  '#1f8a52', // green
  '#d98a1f', // amber
  '#7a4bd4', // purple
  '#e2467f'  // pink
];

const SECTION_COLORS = ['#7a4bd4', '#1f8a52', '#1f5fd0', '#d98a1f', '#c8402f', '#e2467f'];

// ---- Elements -------------------------------------------------------------
const stage      = $('#stage');
const canvas     = $('#ink');
const ctx        = canvas.getContext('2d');
const overlay    = $('#overlay');
const sectionList= $('#sectionList');
const pageList   = $('#pageList');
const saveState  = $('#saveState');
const colorRow   = $('#colorRow');
const sizeRange  = $('#sizeRange');
const sizeDot    = $('#sizeDot');
const zoomLabel  = $('#zoomLevel');
const pageLabel  = $('#pageTitleLabel');

// ---- App state ------------------------------------------------------------
let notebook = null;

const cam = { x: -60, y: -60, scale: 1 };

const tool = {
  name: 'pen',
  color: PALETTE[0],
  size: 3,
  // Per-tool remembered settings, so switching pen -> highlighter -> pen
  // doesn't lose your pen width the way a single shared value would.
  memory: {
    pen:         { color: PALETTE[0], size: 3 },
    highlighter: { color: '#ffd54a',  size: 18 },
    eraser:      { color: PALETTE[0], size: 14 }
  }
};

let dirty = false;
let saveTimer = null;

// ---------------------------------------------------------------------------
// Helpers to reach the active page
// ---------------------------------------------------------------------------
function activeSection() {
  return notebook.sections.find(s => s.id === notebook.activeSectionId)
      || notebook.sections[0];
}

function activePage() {
  const sec = activeSection();
  if (!sec) return null;
  return sec.pages.find(p => p.id === notebook.activePageId) || sec.pages[0];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function blankNotebook() {
  const pageId = uid();
  const secId  = uid();
  return {
    sections: [{
      id: secId,
      name: 'My Notes',
      color: SECTION_COLORS[0],
      pages: [{ id: pageId, title: 'Untitled page', strokes: [], texts: [] }]
    }],
    activeSectionId: secId,
    activePageId: pageId
  };
}

function markDirty() {
  dirty = true;
  saveState.textContent = 'Saving…';
  saveState.classList.add('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 700);
}

async function persist() {
  if (!notebook) return;
  const res = await window.api.save(notebook);
  dirty = false;
  saveState.textContent = res && res.ok ? 'Saved' : 'Save failed';
  saveState.classList.remove('dirty');
}

// Last-chance save if the window is closing mid-debounce.
window.addEventListener('beforeunload', () => {
  if (dirty) { clearTimeout(saveTimer); window.api.save(notebook); }
});

// ---------------------------------------------------------------------------
// Undo / redo — snapshot based, scoped to the active page
// ---------------------------------------------------------------------------
const history = { stacks: new Map(), limit: 80 };

function stackFor(pageId) {
  if (!history.stacks.has(pageId)) {
    history.stacks.set(pageId, { undo: [], redo: [] });
  }
  return history.stacks.get(pageId);
}

function snapshot(page) {
  return JSON.stringify({ strokes: page.strokes, texts: page.texts });
}

function pushHistory() {
  const page = activePage();
  if (!page) return;
  const st = stackFor(page.id);
  const snap = snapshot(page);
  if (st.undo.length && st.undo[st.undo.length - 1] === snap) return;
  st.undo.push(snap);
  if (st.undo.length > history.limit) st.undo.shift();
  st.redo.length = 0;
  refreshHistoryButtons();
}

function applySnapshot(page, snap) {
  const parsed = JSON.parse(snap);
  page.strokes = parsed.strokes;
  page.texts = parsed.texts;
}

function undo() {
  const page = activePage();
  if (!page) return;
  const st = stackFor(page.id);
  if (!st.undo.length) return;
  st.redo.push(snapshot(page));
  applySnapshot(page, st.undo.pop());
  renderPageContent();
  markDirty();
  refreshHistoryButtons();
}

function redo() {
  const page = activePage();
  if (!page) return;
  const st = stackFor(page.id);
  if (!st.redo.length) return;
  st.undo.push(snapshot(page));
  applySnapshot(page, st.redo.pop());
  renderPageContent();
  markDirty();
  refreshHistoryButtons();
}

function refreshHistoryButtons() {
  const page = activePage();
  const st = page ? stackFor(page.id) : { undo: [], redo: [] };
  $('#undoBtn').disabled = !st.undo.length;
  $('#redoBtn').disabled = !st.redo.length;
}

// ---------------------------------------------------------------------------
// Canvas sizing & camera
// ---------------------------------------------------------------------------
let dpr = window.devicePixelRatio || 1;

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const r = stage.getBoundingClientRect();
  canvas.width  = Math.max(1, Math.round(r.width  * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  drawAll();
}

new ResizeObserver(resizeCanvas).observe(stage);

function toWorld(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  return {
    x: (clientX - r.left) / cam.scale + cam.x,
    y: (clientY - r.top)  / cam.scale + cam.y
  };
}

function applyCamera() {
  ctx.setTransform(
    cam.scale * dpr, 0, 0, cam.scale * dpr,
    -cam.x * cam.scale * dpr,
    -cam.y * cam.scale * dpr
  );
  overlay.style.transform =
    `translate(${-cam.x * cam.scale}px, ${-cam.y * cam.scale}px) scale(${cam.scale})`;
  // Move the dot grid with the camera so panning feels anchored.
  const step = 24 * cam.scale;
  stage.style.backgroundSize = `${step}px ${step}px, auto`;
  stage.style.backgroundPosition =
    `${-cam.x * cam.scale}px ${-cam.y * cam.scale}px, 0 0`;
  zoomLabel.textContent = Math.round(cam.scale * 100) + '%';
}

function setZoom(next, anchorClientX, anchorClientY) {
  const clamped = Math.min(4, Math.max(0.2, next));
  if (clamped === cam.scale) return;
  const r = stage.getBoundingClientRect();
  const ax = anchorClientX == null ? r.width / 2  : anchorClientX - r.left;
  const ay = anchorClientY == null ? r.height / 2 : anchorClientY - r.top;
  // Keep the world point under the anchor fixed while scaling.
  const wx = ax / cam.scale + cam.x;
  const wy = ay / cam.scale + cam.y;
  cam.scale = clamped;
  cam.x = wx - ax / cam.scale;
  cam.y = wy - ay / cam.scale;
  drawAll();
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
function strokeStyleFor(s) {
  if (s.tool === 'highlighter') {
    ctx.globalAlpha = 0.32;
    ctx.globalCompositeOperation = 'multiply';
    ctx.lineCap = 'butt';
  } else {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
  }
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color;
}

function paintStroke(s) {
  const pts = s.points;
  if (!pts.length) return;
  strokeStyleFor(s);

  if (pts.length === 1) {
    ctx.beginPath();
    ctx.fillStyle = s.color;
    ctx.arc(pts[0][0], pts[0][1], s.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  if (s.tool === 'highlighter') {
    // Flat, constant width — pressure on a highlighter looks wrong.
    ctx.lineWidth = s.size;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    return;
  }

  // Pen: draw each segment separately so pressure can vary the width, and
  // use a quadratic midpoint curve so the line reads smooth, not polygonal.
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const w = s.size * (0.55 + 0.9 * (b[2] == null ? 0.5 : b[2]));
    ctx.lineWidth = Math.max(0.4, w);
    ctx.beginPath();
    if (i === 1) {
      ctx.moveTo(a[0], a[1]);
    } else {
      const prev = pts[i - 2];
      ctx.moveTo((prev[0] + a[0]) / 2, (prev[1] + a[1]) / 2);
    }
    ctx.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    ctx.stroke();
  }
}

function drawAll() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyCamera();
  const page = activePage();
  if (!page) return;
  // Highlighter first so it sits behind pen ink, like a real highlighter.
  for (const s of page.strokes) if (s.tool === 'highlighter') paintStroke(s);
  for (const s of page.strokes) if (s.tool !== 'highlighter') paintStroke(s);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------------------
// Pointer interaction on the stage
// ---------------------------------------------------------------------------
let drawing = null;     // stroke in progress
let panning = null;     // { startX, startY, camX, camY }
let spaceDown = false;
let erasedAny = false;

const INK_TOOLS = new Set(['pen', 'highlighter', 'eraser']);

function setTool(name) {
  if (INK_TOOLS.has(tool.name) && tool.memory[tool.name]) {
    tool.memory[tool.name] = { color: tool.color, size: tool.size };
  }
  tool.name = name;
  const mem = tool.memory[name];
  if (mem) { tool.color = mem.color; tool.size = mem.size; }

  $$('#toolbar .tool[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === name));

  stage.classList.toggle('tool-select', name === 'select');
  stage.classList.toggle('tool-text',   name === 'text');
  overlay.classList.toggle('ink-mode',  INK_TOOLS.has(name));

  sizeRange.value = tool.size;
  syncColorRow();
  syncSizeDot();
}

function syncColorRow() {
  $$('#colorRow .swatch-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.color === tool.color));
}

function syncSizeDot() {
  const d = Math.max(3, Math.min(22, tool.size));
  sizeDot.style.width = d + 'px';
  sizeDot.style.height = d + 'px';
  sizeDot.style.background = tool.name === 'eraser' ? '#b9b2a7' : tool.color;
}

stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.textbox')) return; // text boxes handle themselves

  // Pan: middle mouse, or space held with any button.
  if (e.button === 1 || (spaceDown && e.button === 0)) {
    panning = { startX: e.clientX, startY: e.clientY, camX: cam.x, camY: cam.y };
    stage.classList.add('panning');
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  if (e.button !== 0) return;
  const page = activePage();
  if (!page) return;
  const w = toWorld(e.clientX, e.clientY);

  if (tool.name === 'text') {
    pushHistory();
    const tb = { id: uid(), x: w.x, y: w.y, w: 320, text: '' };
    page.texts.push(tb);
    const el = mountTextbox(tb);
    markDirty();
    // Let the element land in the DOM before focusing it.
    requestAnimationFrame(() => focusTextbox(el));
    return;
  }

  if (tool.name === 'select') {
    clearTextSelection();
    return;
  }

  if (tool.name === 'eraser') {
    erasedAny = false;
    pushHistory();
    stage.setPointerCapture(e.pointerId);
    drawing = { erasing: true };
    eraseAt(w);
    return;
  }

  // pen / highlighter
  pushHistory();
  stage.setPointerCapture(e.pointerId);
  drawing = {
    id: uid(),
    tool: tool.name,
    color: tool.color,
    size: tool.size,
    points: [[w.x, w.y, e.pressure || 0.5]]
  };
  page.strokes.push(drawing);
});

stage.addEventListener('pointermove', (e) => {
  if (panning) {
    cam.x = panning.camX - (e.clientX - panning.startX) / cam.scale;
    cam.y = panning.camY - (e.clientY - panning.startY) / cam.scale;
    drawAll();
    return;
  }
  if (!drawing) return;

  const w = toWorld(e.clientX, e.clientY);

  if (drawing.erasing) { eraseAt(w); return; }

  const pts = drawing.points;
  const last = pts[pts.length - 1];
  // Drop sub-pixel moves: they add nothing visually and bloat the file.
  const minStep = 1.1 / cam.scale;
  if (Math.hypot(w.x - last[0], w.y - last[1]) < minStep) return;

  pts.push([w.x, w.y, e.pressure || 0.5]);

  // Fast path: paint only the new tail instead of redrawing the whole page.
  if (drawing.tool === 'highlighter') {
    drawAll(); // multiply blending needs a clean redraw to avoid stacking
  } else {
    const tail = { ...drawing, points: pts.slice(-3) };
    paintStroke(tail);
  }
});

function endPointer(e) {
  if (panning) {
    panning = null;
    stage.classList.remove('panning');
    return;
  }
  if (!drawing) return;

  if (drawing.erasing) {
    if (!erasedAny) {
      // Nothing was erased — drop the history entry we optimistically pushed.
      const st = stackFor(activePage().id);
      st.undo.pop();
      refreshHistoryButtons();
    } else {
      markDirty();
    }
  } else {
    if (drawing.points.length < 1) {
      const page = activePage();
      page.strokes = page.strokes.filter(s => s !== drawing);
    }
    markDirty();
    drawAll();
  }
  drawing = null;
}

stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('pointerleave', (e) => { if (drawing || panning) endPointer(e); });

// Stroke-level erase, the way OneNote's stroke eraser works: touch any part
// of a stroke and the whole stroke goes.
function eraseAt(w) {
  const page = activePage();
  const r = Math.max(4, tool.size / 2) / 1;
  const before = page.strokes.length;
  page.strokes = page.strokes.filter(s => !strokeHit(s, w, r + s.size / 2));
  if (page.strokes.length !== before) {
    erasedAny = true;
    drawAll();
  }
}

function strokeHit(s, w, radius) {
  const pts = s.points;
  if (pts.length === 1) {
    return Math.hypot(pts[0][0] - w.x, pts[0][1] - w.y) <= radius;
  }
  for (let i = 1; i < pts.length; i++) {
    if (pointSegmentDist(w.x, w.y, pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]) <= radius) {
      return true;
    }
  }
  return false;
}

function pointSegmentDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Ctrl+wheel zooms; plain wheel pans, matching how OneNote/Figma behave.
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    setZoom(cam.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
  } else {
    cam.x += e.deltaX / cam.scale;
    cam.y += e.deltaY / cam.scale;
    drawAll();
  }
}, { passive: false });

// ---------------------------------------------------------------------------
// Text boxes
// ---------------------------------------------------------------------------
let selectedTextEl = null;

function clearTextSelection() {
  if (selectedTextEl) selectedTextEl.classList.remove('selected');
  selectedTextEl = null;
}

function mountTextbox(tb) {
  const el = document.createElement('div');
  el.className = 'textbox';
  el.contentEditable = 'true';
  el.spellcheck = false;
  el.dataset.id = tb.id;
  el.style.left = tb.x + 'px';
  el.style.top  = tb.y + 'px';
  el.style.width = (tb.w || 320) + 'px';
  el.textContent = tb.text || '';
  el.dataset.empty = tb.text ? 'false' : 'true';

  const handle = document.createElement('div');
  handle.className = 'drag-handle';
  handle.contentEditable = 'false';
  el.appendChild(handle);

  let textSaveTimer = null;
  el.addEventListener('input', () => {
    const text = readText(el);
    tb.text = text;
    el.dataset.empty = text ? 'false' : 'true';
    markDirty();
    clearTimeout(textSaveTimer);
    textSaveTimer = setTimeout(pushHistory, 900); // coalesce typing bursts
  });

  el.addEventListener('focus', () => {
    clearTextSelection();
    el.classList.add('editing');
  });

  el.addEventListener('blur', () => {
    el.classList.remove('editing');
    if (!readText(el)) removeTextbox(tb, el);
  });

  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (e.target === handle) {
      startTextDrag(e, tb, el);
      return;
    }
    if (tool.name === 'select') {
      clearTextSelection();
      selectedTextEl = el;
      el.classList.add('selected');
    }
  });

  // Persist manual width changes from the CSS resize grabber.
  new ResizeObserver(() => {
    const w = el.offsetWidth;
    if (w && Math.abs(w - (tb.w || 0)) > 1) { tb.w = w; markDirty(); }
  }).observe(el);

  overlay.appendChild(el);
  return el;
}

// The drag handle is a child node, so textContent would include nothing for
// it (it's empty) but innerText can pick up stray breaks — read child text
// nodes only, and normalise the trailing <br> Chromium adds.
function readText(el) {
  let out = '';
  el.childNodes.forEach(n => {
    if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue;
    else if (n.nodeName === 'BR') out += '\n';
    else if (n.nodeType === Node.ELEMENT_NODE && !n.classList.contains('drag-handle')) {
      out += n.innerText;
    }
  });
  return out.replace(/\n+$/, '');
}

function focusTextbox(el) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function removeTextbox(tb, el) {
  const page = activePage();
  page.texts = page.texts.filter(t => t.id !== tb.id);
  el.remove();
  if (selectedTextEl === el) selectedTextEl = null;
  markDirty();
}

function startTextDrag(e, tb, el) {
  e.preventDefault();
  pushHistory();
  const start = toWorld(e.clientX, e.clientY);
  const ox = tb.x, oy = tb.y;
  const move = (ev) => {
    const w = toWorld(ev.clientX, ev.clientY);
    tb.x = ox + (w.x - start.x);
    tb.y = oy + (w.y - start.y);
    el.style.left = tb.x + 'px';
    el.style.top  = tb.y + 'px';
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    markDirty();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ---------------------------------------------------------------------------
// Page / section rendering
// ---------------------------------------------------------------------------
function renderPageContent() {
  overlay.innerHTML = '';
  clearTextSelection();
  const page = activePage();
  if (!page) return;
  page.texts.forEach(mountTextbox);
  drawAll();
  pageLabel.textContent = `${activeSection().name} › ${page.title}`;
  refreshHistoryButtons();
}

function renderSidebar() {
  // --- sections ---
  sectionList.innerHTML = '';
  notebook.sections.forEach(sec => {
    const li = document.createElement('li');
    li.className = sec.id === notebook.activeSectionId ? 'active' : '';

    const dot = document.createElement('span');
    dot.className = 'swatch';
    dot.style.background = sec.color;

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = sec.name;
    label.addEventListener('dblclick', () => startRename(label, (v) => {
      sec.name = v; markDirty(); renderSidebar(); renderPageContent();
    }));

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete section';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (notebook.sections.length === 1) return;
      notebook.sections = notebook.sections.filter(s => s.id !== sec.id);
      if (notebook.activeSectionId === sec.id) {
        notebook.activeSectionId = notebook.sections[0].id;
        notebook.activePageId = notebook.sections[0].pages[0].id;
      }
      markDirty(); renderSidebar(); renderPageContent();
    });

    li.append(dot, label, del);
    li.addEventListener('click', () => {
      notebook.activeSectionId = sec.id;
      notebook.activePageId = sec.pages.length ? sec.pages[0].id : null;
      if (!sec.pages.length) addPage();
      markDirty(); renderSidebar(); renderPageContent();
    });
    sectionList.appendChild(li);
  });

  // --- pages of the active section ---
  pageList.innerHTML = '';
  const sec = activeSection();
  if (!sec) return;
  sec.pages.forEach(pg => {
    const li = document.createElement('li');
    li.className = pg.id === notebook.activePageId ? 'active' : '';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = pg.title;
    label.addEventListener('dblclick', () => startRename(label, (v) => {
      pg.title = v; markDirty(); renderSidebar();
      pageLabel.textContent = `${sec.name} › ${pg.title}`;
    }));

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete page';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (sec.pages.length === 1) return;
      sec.pages = sec.pages.filter(p => p.id !== pg.id);
      history.stacks.delete(pg.id);
      if (notebook.activePageId === pg.id) notebook.activePageId = sec.pages[0].id;
      markDirty(); renderSidebar(); renderPageContent();
    });

    li.append(label, del);
    li.addEventListener('click', () => {
      notebook.activePageId = pg.id;
      markDirty(); renderSidebar(); renderPageContent();
    });
    pageList.appendChild(li);
  });
}

function startRename(label, commit) {
  const original = label.textContent;
  label.contentEditable = 'true';
  label.focus();
  const range = document.createRange();
  range.selectNodeContents(label);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = (save) => {
    label.contentEditable = 'false';
    const v = label.textContent.trim();
    if (save && v) commit(v);
    else label.textContent = original;
  };
  label.addEventListener('blur', () => finish(true), { once: true });
  label.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); label.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
}

function addSection() {
  const pageId = uid();
  const sec = {
    id: uid(),
    name: 'New section',
    color: SECTION_COLORS[notebook.sections.length % SECTION_COLORS.length],
    pages: [{ id: pageId, title: 'Untitled page', strokes: [], texts: [] }]
  };
  notebook.sections.push(sec);
  notebook.activeSectionId = sec.id;
  notebook.activePageId = pageId;
  markDirty(); renderSidebar(); renderPageContent();
}

function addPage() {
  const sec = activeSection();
  const pg = { id: uid(), title: 'Untitled page', strokes: [], texts: [] };
  sec.pages.push(pg);
  notebook.activePageId = pg.id;
  markDirty(); renderSidebar(); renderPageContent();
}

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------
PALETTE.concat(['#ffd54a']).forEach(c => {
  const b = document.createElement('button');
  b.className = 'swatch-btn';
  b.dataset.color = c;
  b.style.background = c;
  b.title = c;
  b.addEventListener('click', () => {
    tool.color = c;
    if (tool.memory[tool.name]) tool.memory[tool.name].color = c;
    syncColorRow(); syncSizeDot();
  });
  colorRow.appendChild(b);
});

$$('#toolbar .tool[data-tool]').forEach(b =>
  b.addEventListener('click', () => setTool(b.dataset.tool)));

sizeRange.addEventListener('input', () => {
  tool.size = Number(sizeRange.value);
  if (tool.memory[tool.name]) tool.memory[tool.name].size = tool.size;
  syncSizeDot();
});

$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#addSection').addEventListener('click', addSection);
$('#addPage').addEventListener('click', addPage);
$('#zoomIn').addEventListener('click', () => setZoom(cam.scale * 1.2));
$('#zoomOut').addEventListener('click', () => setZoom(cam.scale / 1.2));
$('#zoomLevel').addEventListener('click', () => setZoom(1));

$('#exportBtn').addEventListener('click', () => window.api.exportNotebook(notebook));
$('#importBtn').addEventListener('click', async () => {
  const res = await window.api.importNotebook();
  if (res && res.ok && res.data && Array.isArray(res.data.sections)) {
    notebook = res.data;
    history.stacks.clear();
    markDirty(); renderSidebar(); renderPageContent();
  }
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
function typingInField(e) {
  const t = e.target;
  return t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !typingInField(e)) { spaceDown = true; }

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); persist(); return; }
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); addPage(); return; }

  if (typingInField(e)) return;

  const map = { v: 'select', t: 'text', p: 'pen', h: 'highlighter', e: 'eraser' };
  const next = map[e.key.toLowerCase()];
  if (next) { setTool(next); return; }

  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTextEl) {
    e.preventDefault();
    const id = selectedTextEl.dataset.id;
    const page = activePage();
    const tb = page.texts.find(t => t.id === id);
    if (tb) { pushHistory(); removeTextbox(tb, selectedTextEl); }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceDown = false;
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function init() {
  const loaded = await window.api.load();
  notebook = (loaded && Array.isArray(loaded.sections) && loaded.sections.length)
    ? loaded
    : blankNotebook();

  // Guard against a stale/missing active id in a hand-edited file.
  if (!activeSection()) notebook.activeSectionId = notebook.sections[0].id;
  if (!activePage()) notebook.activePageId = activeSection().pages[0].id;

  setTool('pen');
  renderSidebar();
  resizeCanvas();
  renderPageContent();
  saveState.textContent = 'Saved';
})();
