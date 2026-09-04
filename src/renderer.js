/* ==========================================================================
   InkNote — renderer
   --------------------------------------------------------------------------
   Data model (v2)
     notebook = { version, variables: [ Variable ], sections: [ Section ],
                  activeSectionId, activePageId }
     Variable = { id, name }        shared across the whole notebook
     Section  = { id, name, color, pages: [ Page ] }
     Page     = { id, title, strokes: [ Stroke ], items: [ Item ], links: [ Link ] }
     Stroke   = { id, tool, color, size, points: [ [x, y, pressure] ] }
     Item     = { id, type, x, y, w, h?, parent?, order?, ...typeFields }
                  card      -> { text, color }
                  checklist -> { rows: [ { id, text, done } ], color }
                  image  -> { src }   (src null until a picture is attached)
                  field  -> { varId, value }   name is shared, value is not.
                            A field can host one child box in place of its
                            text — drop a link box in and that becomes its
                            value.
                  link   -> { target, anchor, label }
                            target = a page id, anchor = an item id on it
                  column -> { title, collapsed }   stacks children vertically
                  row    -> { title, collapsed }   lays them out side by side
     Link     = { id, from, to, color }

   Ink and board items share one page. Ink is painted on a canvas beneath the
   items so cards sit on top of your scribbles, the way paper cut-outs would.

   All coordinates are WORLD coordinates. The camera maps world to screen:
     screen = (world - cam) * cam.scale
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
  '#e2467f', // pink
  '#ffd54a'  // highlighter yellow
];

const SECTION_COLORS = ['#7a4bd4', '#1f8a52', '#1f5fd0', '#d98a1f', '#c8402f', '#e2467f'];

const DEFAULTS = {
  card:      { w: 260 },
  checklist: { w: 280 },
  column: { w: 300 },
  row:    { },
  image:  { w: 320, h: 200 },
  link:   { w: 260 },
  field:  { w: 300 }
};

// ---- Elements -------------------------------------------------------------
const stage       = $('#stage');
const canvas      = $('#ink');
const ctx         = canvas.getContext('2d');
const overlay     = $('#overlay');
const itemsLayer  = $('#items');
const linkPaths   = $('#linkPaths');
const sectionList = $('#sectionList');
const pageList    = $('#pageList');
const saveState   = $('#saveState');
const colorRow    = $('#colorRow');
const sizeRange   = $('#sizeRange');
const sizeDot     = $('#sizeDot');
const zoomLabel   = $('#zoomLevel');
const pageLabel   = $('#pageTitleLabel');
const linkHint    = $('#linkHint');
const selectionLabel = $('#selectionLabel');

// ---- App state ------------------------------------------------------------
let notebook = null;

const cam = { x: -60, y: -60, scale: 1 };

const INK_TOOLS = new Set(['pen', 'highlighter', 'eraser']);

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

const elMap = new Map();      // item id -> DOM element
// Selection is a set; `selectedItemId` is the most recently added member and
// acts as the "primary" for anything that only makes sense on one box.
const selection = new Set();
let selectedItemId = null;
let selectedLinkId = null;
let linkSourceId = null;      // arrow tool: first item clicked

let dirty = false;
let saveTimer = null;

// ---------------------------------------------------------------------------
// Active section / page
// ---------------------------------------------------------------------------
function activeSection() {
  // The canvas can be asked to paint before the notebook has finished
  // loading — a ResizeObserver fires as soon as the stage has a size.
  if (!notebook || !notebook.sections) return null;
  return notebook.sections.find(s => s.id === notebook.activeSectionId)
      || notebook.sections[0];
}

function activePage() {
  const sec = activeSection();
  if (!sec) return null;
  return sec.pages.find(p => p.id === notebook.activePageId) || sec.pages[0];
}

function itemById(id) {
  const page = activePage();
  return page ? page.items.find(i => i.id === id) : null;
}

// ---------------------------------------------------------------------------
// Persistence & migration
// ---------------------------------------------------------------------------
function blankPage() {
  return { id: uid(), title: 'Untitled page', strokes: [], items: [], links: [] };
}

function blankNotebook() {
  const page = blankPage();
  const secId = uid();
  return {
    version: 2,
    variables: [],
    recentLinks: [],
    sections: [{ id: secId, name: 'My Notes', color: SECTION_COLORS[0], pages: [page] }],
    activeSectionId: secId,
    activePageId: page.id
  };
}

// v0.1 stored free text boxes in `page.texts`. Turn each into a card so old
// notebooks open without losing anything.
function migrate(nb) {
  if (!nb || !Array.isArray(nb.sections)) return null;
  if (!Array.isArray(nb.variables)) nb.variables = [];
  if (!Array.isArray(nb.recentLinks)) nb.recentLinks = [];
  const seedRecents = nb.recentLinks.length === 0;
  for (const sec of nb.sections) {
    if (!Array.isArray(sec.pages)) sec.pages = [];
    for (const pg of sec.pages) {
      if (!Array.isArray(pg.strokes)) pg.strokes = [];
      if (!Array.isArray(pg.items)) pg.items = [];
      if (!Array.isArray(pg.links)) pg.links = [];
      for (const it of pg.items) {
        // Columns used to carry a fixed height, which left dead space under
        // their cards. They size to their contents now.
        if (it.type === 'column') delete it.h;
        if (it.type === 'link' && !('label' in it)) it.label = null;
      }
      if (Array.isArray(pg.texts)) {
        for (const t of pg.texts) {
          pg.items.push({
            id: t.id || uid(), type: 'card',
            x: t.x || 0, y: t.y || 0, w: t.w || DEFAULTS.card.w,
            text: t.text || '', color: null
          });
        }
        delete pg.texts;
      }
    }
    if (!sec.pages.length) sec.pages.push(blankPage());
  }
  // First run after this feature arrived: the notebook is probably already
  // full of links, and they're exactly the targets worth remembering. Seed
  // the list from them rather than starting empty.
  if (seedRecents) {
    const seen = new Set();
    for (const sec of nb.sections) {
      for (const pg of sec.pages) {
        for (const it of pg.items) {
          if (it.type !== 'link' || !it.target) continue;
          const key = `${it.target}|${it.anchor || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          nb.recentLinks.push({ pageId: it.target, anchor: it.anchor || null });
        }
      }
    }
    nb.recentLinks = nb.recentLinks.slice(0, 60);
  }

  nb.version = 2;
  return nb;
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
  if (window.INKNOTE_SYNC && window.INKNOTE_SYNC.configured) {
    window.INKNOTE_SYNC.onLocalChange(notebook);
  }
  dirty = false;
  saveState.textContent = res && res.ok ? 'Saved' : 'Save failed';
  saveState.classList.remove('dirty');
}

window.addEventListener('beforeunload', () => {
  if (dirty) { clearTimeout(saveTimer); window.api.save(notebook); }
});

// ---------------------------------------------------------------------------
// Accepting a notebook from outside (a shared room)
// ---------------------------------------------------------------------------
// Replaces the model wholesale but keeps everything about *this* viewer's
// session: which page they're on, what they had selected, where the camera
// is. An update that yanked you to someone else's page would be unusable.
let pendingRemote = null;

function applyRemoteNotebook(next) {
  if (!next || !Array.isArray(next.sections) || !next.sections.length) return;

  // Never pull the rug while someone is mid-sentence; hold it until they stop.
  if (editingItemId) { pendingRemote = next; return; }

  const keepSection = notebook && notebook.activeSectionId;
  const keepPage = notebook && notebook.activePageId;
  const keepSelection = [...selection];

  notebook = migrate(next) || next;
  notebook.activeSectionId = keepSection;
  notebook.activePageId = keepPage;
  if (!activeSection()) notebook.activeSectionId = notebook.sections[0].id;
  if (!activePage()) notebook.activePageId = activeSection().pages[0].id;

  renderSidebar();
  renderPageContent();

  selection.clear();
  keepSelection.forEach(id => { if (itemById(id)) selection.add(id); });
  selectedItemId = selection.has(selectedItemId) ? selectedItemId : null;
  paintSelection();
}

function applyPendingRemote() {
  if (!pendingRemote) return;
  const next = pendingRemote;
  pendingRemote = null;
  applyRemoteNotebook(next);
}

// ---------------------------------------------------------------------------
// Confirmation modal — promise-based, replaces window.confirm
// ---------------------------------------------------------------------------
const modalBackdrop = $('#modalBackdrop');
const modalInput = $('#modalInput');
let modalResolve = null;
let modalIsPrompt = false;

function openModal({ title, body, okLabel = 'OK', prompt = false, value = '', danger = true }) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    modalIsPrompt = prompt;
    $('#modalTitle').textContent = title;
    $('#modalBody').textContent = body;
    $('#modalOk').textContent = okLabel;
    $('#modalOk').className = danger ? 'danger-btn' : 'primary-btn';

    modalInput.hidden = !prompt;
    modalInput.value = prompt ? value : '';
    modalBackdrop.hidden = false;

    if (prompt) { modalInput.focus(); modalInput.select(); }
    else $('#modalCancel').focus();
  });
}

function confirmDelete({ title, body, okLabel = 'Delete' }) {
  return openModal({ title, body, okLabel });
}

// Resolves to the typed string, or null if cancelled.
function promptText({ title, body, value = '', okLabel = 'Save' }) {
  return openModal({ title, body, okLabel, prompt: true, value, danger: false });
}

function closeModal(result) {
  if (!modalResolve) return;
  const wasPrompt = modalIsPrompt;
  const typed = modalInput.value;
  modalBackdrop.hidden = true;
  modalInput.hidden = true;
  modalIsPrompt = false;
  const r = modalResolve;
  modalResolve = null;
  r(wasPrompt ? (result ? typed : null) : result);
}

$('#modalOk').addEventListener('click', () => closeModal(true));
$('#modalCancel').addEventListener('click', () => closeModal(false));
modalBackdrop.addEventListener('pointerdown', (e) => {
  if (e.target === modalBackdrop) closeModal(false);
});

// ---------------------------------------------------------------------------
// Undo / redo — snapshot based, scoped to the active page
// ---------------------------------------------------------------------------
const history = { stacks: new Map(), limit: 80 };

function stackFor(pageId) {
  if (!history.stacks.has(pageId)) history.stacks.set(pageId, { undo: [], redo: [] });
  return history.stacks.get(pageId);
}

function snapshot(page) {
  return JSON.stringify({ strokes: page.strokes, items: page.items, links: page.links });
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
  page.items = parsed.items;
  page.links = parsed.links;
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

function viewportCenterWorld() {
  const r = stage.getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
}

function applyCamera() {
  ctx.setTransform(
    cam.scale * dpr, 0, 0, cam.scale * dpr,
    -cam.x * cam.scale * dpr,
    -cam.y * cam.scale * dpr
  );
  overlay.style.transform =
    `translate(${-cam.x * cam.scale}px, ${-cam.y * cam.scale}px) scale(${cam.scale})`;
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
// Home — get back to the work when you've panned off into empty space
// ---------------------------------------------------------------------------
const HOME_CAM = { x: -60, y: -60, scale: 1 };

// Bounding box of everything on the page, in world coordinates. Uses the
// rendered size of each box (they grow to fit their contents, so the model
// alone doesn't know how tall anything is) plus every ink point.
function contentBounds() {
  const page = activePage();
  if (!page) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let found = false;

  for (const item of topLevelItems(page)) {
    const el = elMap.get(item.id);
    if (!el) continue;
    const r = worldRect(el);
    if (!r.w && !r.h) continue;
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    found = true;
  }

  for (const st of page.strokes) {
    for (const pt of st.points) {
      minX = Math.min(minX, pt[0]); minY = Math.min(minY, pt[1]);
      maxX = Math.max(maxX, pt[0]); maxY = Math.max(maxY, pt[1]);
      found = true;
    }
  }

  if (!found) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

let homeTween = null;

// Frames everything on the page. An empty page just goes back to the origin.
// Never zooms past 100% — blowing a single card up to fill the window is
// disorienting, which is the opposite of the point.
function goHome({ animate = true } = {}) {
  const view = stage.getBoundingClientRect();
  const bounds = contentBounds();
  let target;

  if (!bounds || view.width < 2 || view.height < 2) {
    target = { ...HOME_CAM };
  } else {
    const pad = 70;
    const scale = Math.max(0.2, Math.min(1,
      (view.width  - pad * 2) / Math.max(1, bounds.w),
      (view.height - pad * 2) / Math.max(1, bounds.h)
    ));
    target = {
      scale,
      x: bounds.x + bounds.w / 2 - view.width  / (2 * scale),
      y: bounds.y + bounds.h / 2 - view.height / (2 * scale)
    };
  }

  if (homeTween) { cancelAnimationFrame(homeTween); homeTween = null; }

  if (!animate) {
    Object.assign(cam, target);
    drawAll();
    return target;
  }

  const from = { x: cam.x, y: cam.y, scale: cam.scale };
  const t0 = performance.now();
  const DUR = 260;
  const ease = (t) => 1 - Math.pow(1 - t, 3);

  const step = (now) => {
    const t = Math.min(1, (now - t0) / DUR);
    const k = ease(t);
    cam.x = from.x + (target.x - from.x) * k;
    cam.y = from.y + (target.y - from.y) * k;
    cam.scale = from.scale + (target.scale - from.scale) * k;
    drawAll();
    homeTween = t < 1 ? requestAnimationFrame(step) : null;
  };
  homeTween = requestAnimationFrame(step);
  return target;
}

// ---------------------------------------------------------------------------
// Ink drawing
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

  // Pen: per-segment width so pressure shows, quadratic midpoints so the
  // line reads smooth rather than polygonal.
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
  if (page) {
    // Highlighter first so it sits behind pen ink, like a real highlighter.
    for (const s of page.strokes) if (s.tool === 'highlighter') paintStroke(s);
    for (const s of page.strokes) if (s.tool !== 'highlighter') paintStroke(s);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  scheduleLinkDraw();
}

// ---------------------------------------------------------------------------
// Variables — a notebook-wide list of names that field boxes point at
// ---------------------------------------------------------------------------
// Boxes store a variable *id*, not its text, so renaming a variable renames it
// everywhere at once. The value beside the name belongs to the box alone.
function variableById(id) {
  return notebook.variables.find(v => v.id === id) || null;
}

function variableName(id) {
  const v = variableById(id);
  return v ? v.name : null;
}

function sortedVariables() {
  return notebook.variables
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function findVariableByName(name) {
  const key = name.trim().toLowerCase();
  return notebook.variables.find(v => v.name.trim().toLowerCase() === key) || null;
}

function createVariable(name) {
  const clean = (name || '').trim();
  if (!clean) return null;
  const existing = findVariableByName(clean);   // never make a second "Health"
  if (existing) return existing;
  const v = { id: uid(), name: clean };
  notebook.variables.push(v);
  markDirty();
  return v;
}

function renameVariable(id, name) {
  const v = variableById(id);
  const clean = (name || '').trim();
  if (!v || !clean) return false;
  const clash = findVariableByName(clean);
  if (clash && clash.id !== id) return false;
  v.name = clean;
  markDirty();
  renderItems();
  return true;
}

function fieldsUsingVariable(id) {
  const out = [];
  for (const sec of notebook.sections) {
    for (const pg of sec.pages) {
      for (const it of pg.items) if (it.type === 'field' && it.varId === id) out.push(it);
    }
  }
  return out;
}

// Removing a name leaves the boxes in place with their values intact; they
// just go back to asking which variable they are.
function deleteVariable(id) {
  notebook.variables = notebook.variables.filter(v => v.id !== id);
  fieldsUsingVariable(id).forEach(f => { f.varId = null; });
  markDirty();
  renderItems();
}

// ---------------------------------------------------------------------------
// Link targets you've used before
// ---------------------------------------------------------------------------
// Going to a page and hunting for a block is fine the first time. After that
// the target should just be typeable, so every target you pick is remembered
// and offered by name.
const linkKey = (pageId, anchor) => `${pageId}|${anchor || ''}`;

function recordLinkTarget(pageId, anchor) {
  if (!pageId) return;
  if (!Array.isArray(notebook.recentLinks)) notebook.recentLinks = [];
  const entry = { pageId, anchor: anchor || null };
  notebook.recentLinks = [entry, ...notebook.recentLinks
    .filter(r => linkKey(r.pageId, r.anchor) !== linkKey(pageId, anchor))]
    .slice(0, 60);
  markDirty();
}

// Drops entries whose page or block has since been deleted.
function recentLinkTargets() {
  return (notebook.recentLinks || []).filter(r => {
    const hit = findPage(r.pageId);
    if (!hit) return false;
    return r.anchor ? hit.page.items.some(i => i.id === r.anchor) : true;
  });
}

// Blocks matching what you've typed. With no query, the ones you've linked to
// before — that's the "saved" list.
function blockChoices(query) {
  const q = (query || '').trim().toLowerCase();
  const recents = recentLinkTargets().filter(r => r.anchor);
  const rank = new Map(recents.map((r, i) => [linkKey(r.pageId, r.anchor), i]));

  const out = [];
  for (const sec of notebook.sections) {
    for (const pg of sec.pages) {
      for (const it of pg.items) {
        const key = linkKey(pg.id, it.id);
        const known = rank.has(key);
        if (!q && !known) continue;               // nothing typed: recents only
        const label = blockLabel(it) || '';
        if (q && !label.toLowerCase().includes(q)) continue;
        out.push({
          pageId: pg.id, itemId: it.id, label,
          pageTitle: pg.title, sectionName: sec.name, color: sec.color,
          rank: known ? rank.get(key) : Infinity
        });
      }
    }
  }

  out.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));

  // Two boxes on the same page reading the same thing are indistinguishable
  // in this list, so only the best one is offered: the remembered target if
  // there is one, since sorting has already put it first.
  const shown = new Set();
  const deduped = out.filter(b => {
    const key = `${b.pageId}|${b.label.trim().toLowerCase()}`;
    if (shown.has(key)) return false;
    shown.add(key);
    return true;
  });

  return deduped.slice(0, 24);
}

// ---------------------------------------------------------------------------
// Page lookup & navigation (used by link boxes)
// ---------------------------------------------------------------------------
function findPage(pageId) {
  for (const sec of notebook.sections) {
    const page = sec.pages.find(p => p.id === pageId);
    if (page) return { section: sec, page };
  }
  return null;
}

function allPageChoices() {
  const out = [];
  for (const sec of notebook.sections) {
    for (const pg of sec.pages) {
      out.push({ id: pg.id, title: pg.title, section: sec.name, color: sec.color });
    }
  }
  return out;
}

function goToPage(pageId) {
  const hit = findPage(pageId);
  if (!hit) return false;
  notebook.activeSectionId = hit.section.id;
  notebook.activePageId = hit.page.id;
  markDirty();
  renderSidebar();
  renderPageContent();
  return true;
}

// ---------------------------------------------------------------------------
// Board items — DOM construction
// ---------------------------------------------------------------------------
// Columns and rows are the same machinery pointed in different directions.
const CONTAINER_TYPES = new Set(['column', 'row']);
const isContainer = (item) => !!item && CONTAINER_TYPES.has(item.type);

// A field holds at most one box, in place of its typed value. Columns and rows
// hold any number.
const holdsChildren = (item) => isContainer(item) || (item && item.type === 'field');

function fieldChild(item) {
  const page = activePage();
  if (!page || !item || item.type !== 'field') return null;
  return childrenOf(page, item.id)[0] || null;
}

// The element a drop is tested against for each kind of parent.
function dropSlot(el, item) {
  if (!el) return null;
  return item.type === 'field'
    ? el.querySelector(':scope > .fld-row > .fld-slot')
    : el.querySelector(':scope > .col-body');
}

function topLevelItems(page) {
  return page.items.filter(i => !i.parent);
}

// Every item nested under `id`, at any depth, including `id` itself.
// Used to stop a column being dropped inside itself and to delete a whole
// subtree in one go.
function descendantIds(id) {
  const page = activePage();
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const it of page.items) {
      if (it.parent && out.has(it.parent) && !out.has(it.id)) { out.add(it.id); grew = true; }
    }
  }
  return out;
}

function childrenOf(page, colId) {
  return page.items
    .filter(i => i.parent === colId)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

function renderItems() {
  itemsLayer.innerHTML = '';
  elMap.clear();
  const page = activePage();
  if (!page) return;

  for (const item of topLevelItems(page)) {
    const el = buildItem(item);
    itemsLayer.appendChild(el);
  }
  paintSelection();
  scheduleLinkDraw();
}

function buildItem(item) {
  const el =
    item.type === 'card'      ? buildCard(item)      :
    item.type === 'checklist' ? buildChecklist(item) :
    item.type === 'image'     ? buildImage(item)     :
    item.type === 'link'      ? buildPageLink(item)  :
    item.type === 'field'     ? buildField(item)     :
    item.type === 'column'    ? buildContainer(item, false) :
    item.type === 'row'       ? buildContainer(item, true)  : null;

  if (!el) return document.createComment('unknown item');

  el.classList.add('item');
  el.dataset.id = item.id;
  if (!item.parent) {
    el.style.left = item.x + 'px';
    el.style.top  = item.y + 'px';
  }
  // A field hosting a box lets that box decide the width instead.
  const hosting = item.type === 'field' && fieldChild(item);
  if (item.w && !hosting) el.style.width = item.w + 'px';
  if (item.h) el.style.height = item.h + 'px';

  el.appendChild(makeGrip(item, el));
  el.appendChild(makeKill(item));
  el.appendChild(makeResize(item, el));

  el.addEventListener('pointerdown', (e) => onItemPointerDown(e, item, el));
  el.addEventListener('contextmenu', (e) => {
    if (blockPick) return;
    e.preventDefault();
    e.stopPropagation();
    selectItem(item.id);
    openItemMenu(e.clientX, e.clientY, item);
  });

  elMap.set(item.id, el);
  return el;
}

function makeGrip(item, el) {
  const grip = document.createElement('div');
  grip.className = 'grip';
  grip.title = 'Drag to move';
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    startItemDrag(e, item, el);
  });
  return grip;
}

function makeKill(item) {
  const kill = document.createElement('button');
  kill.className = 'kill';
  kill.textContent = '×';
  kill.title = 'Delete';
  kill.addEventListener('pointerdown', (e) => e.stopPropagation());
  kill.addEventListener('click', (e) => { e.stopPropagation(); requestDeleteItem(item); });
  return kill;
}

function makeResize(item, el) {
  // A row's whole job is to fit its contents, so there's nothing to drag.
  if (item.type === 'row') return document.createComment('no resize');
  const h = document.createElement('div');
  h.className = 'resize';
  h.title = 'Resize';
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    pushHistory();
    const start = toWorld(e.clientX, e.clientY);
    const w0 = el.offsetWidth;
    const h0 = el.offsetHeight;
    const move = (ev) => {
      const w = toWorld(ev.clientX, ev.clientY);
      item.w = Math.max(90, Math.round(w0 + (w.x - start.x)));
      el.style.width = item.w + 'px';
      // Only images take an explicit height. Cards, checklists and columns
      // grow to fit what's inside them.
      if (item.type === 'image') {
        item.h = Math.max(60, Math.round(h0 + (w.y - start.y)));
        el.style.height = item.h + 'px';
      }
      scheduleLinkDraw();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      markDirty();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  return h;
}

// --- card ---
function buildCard(item) {
  const el = document.createElement('div');
  el.className = 'card';
  applyCardColor(el, item);

  const body = document.createElement('div');
  body.className = 'card-body';
  // Not editable until you ask for it. A single click selects the card as an
  // object (so Delete removes the card), double-click drops you into the text.
  body.contentEditable = 'false';
  body.spellcheck = false;
  body.textContent = item.text || '';
  el.dataset.empty = item.text ? 'false' : 'true';

  let coalesce = null;
  body.addEventListener('input', () => {
    item.text = readEditable(body);
    el.dataset.empty = item.text ? 'false' : 'true';
    markDirty();
    scheduleLinkDraw();
    clearTimeout(coalesce);
    coalesce = setTimeout(pushHistory, 900); // one undo step per typing burst
  });
  body.addEventListener('dblclick', (e) => { e.stopPropagation(); beginEdit(item); });
  body.addEventListener('blur', () => scheduleEndEdit(item));

  el.appendChild(body);
  return el;
}

// Which item, if any, currently has an open text caret.
let editingItemId = null;

// The editable text nodes an item owns — one for a card or column header,
// one per row for a checklist.
function editFields(el, type) {
  if (!el) return [];
  const sel = CONTAINER_TYPES.has(type) ? ':scope > .col-bar > .col-head'
            : type === 'checklist' ? ':scope > .chk-body .chk-text'
            : type === 'link'      ? ':scope > .pl-main > .pl-label'
            : type === 'field'     ? ':scope > .fld-row > .fld-slot > .fld-value'
            :                        ':scope > .card-body';
  return Array.from(el.querySelectorAll(sel));
}

function beginEdit(itemOrId, preferredField) {
  const item = typeof itemOrId === 'string' ? itemById(itemOrId) : itemOrId;
  if (!item) return;
  const el = elMap.get(item.id);
  if (!el) return;

  const fields = editFields(el, item.type);
  if (!fields.length) return;
  const field = preferredField && fields.includes(preferredField)
    ? preferredField
    : fields[0];

  editingItemId = item.id;
  selectItem(item.id);
  el.classList.add('editing');
  fields.forEach(f => { f.contentEditable = 'true'; });
  field.focus();

  const range = document.createRange();
  range.selectNodeContents(field);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function endEdit(item) {
  const page = activePage();
  if (!page || !page.items.includes(item)) return; // already gone
  const el = elMap.get(item.id);
  if (el) {
    el.classList.remove('editing');
    editFields(el, item.type).forEach(f => { f.contentEditable = 'false'; });
  }
  if (editingItemId === item.id) editingItemId = null;

  // A card left completely empty was almost certainly a misclick. Skip this
  // when the blur came from the DOM being rebuilt underneath us — the item is
  // fine, its element just isn't on the page any more.
  const detached = !el || !el.isConnected;
  if (item.type === 'card' && !item.text && !detached) removeItem(item, { silent: true });

  // A room update that arrived while you were typing lands now.
  if (!editingItemId) applyPendingRemote();
}

function stopEditing() {
  if (!editingItemId) { applyPendingRemote(); return false; }
  const item = itemById(editingItemId);
  const el = elMap.get(editingItemId);
  if (el) {
    const active = editFields(el, item && item.type);
    active.forEach(f => f.blur());
  }
  if (item) endEdit(item);
  editingItemId = null;
  return true;
}

// A blur can mean "left the item" or "hopped to the next checklist row".
// Defer the decision until focus has settled.
function scheduleEndEdit(item) {
  setTimeout(() => {
    const el = elMap.get(item.id);
    if (el && el.contains(document.activeElement)) return; // still inside
    endEdit(item);
  }, 0);
}

// innerText isn't available in every environment (jsdom, for one), and it
// leaves a trailing newline Chromium adds to contenteditable blocks.
function readEditable(node) {
  const raw = node.innerText != null ? node.innerText : node.textContent;
  return (raw || '').replace(/\n+$/, '');
}

function applyCardColor(el, item) {
  if (item.color) {
    el.dataset.color = item.color;
    el.style.setProperty('--card-accent', item.color);
    el.style.background = tint(item.color);
  } else {
    delete el.dataset.color;
    el.style.removeProperty('--card-accent');
    el.style.background = '';
  }
}

// Very light wash of the accent colour for the card background.
function tint(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgb(${Math.round(r + (255 - r) * 0.88)}, ${Math.round(g + (255 - g) * 0.88)}, ${Math.round(b + (255 - b) * 0.88)})`;
}

// --- checklist ---
// Reuses the card's chrome (border, colour rail, shadow) so a board of cards
// and checklists reads as one family of objects.
function newRow(text = '') {
  return { id: uid(), text, done: false };
}

function buildChecklist(item) {
  const el = document.createElement('div');
  el.className = 'card checklist';
  applyCardColor(el, item);

  const body = document.createElement('div');
  body.className = 'chk-body';
  el.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'chk-foot';
  el.appendChild(foot);

  renderChecklistRows(item, el);
  return el;
}

function renderChecklistRows(item, el, focusIndex) {
  if (!Array.isArray(item.rows)) item.rows = [];
  if (!item.rows.length) item.rows.push(newRow());

  const body = el.querySelector(':scope > .chk-body');
  body.innerHTML = '';
  item.rows.forEach((row, i) => body.appendChild(buildChecklistRow(item, el, row, i)));
  updateChecklistProgress(item, el);

  if (focusIndex != null) {
    const fields = editFields(el, 'checklist');
    const field = fields[Math.max(0, Math.min(fields.length - 1, focusIndex))];
    if (field) beginEdit(item, field);
  }
}

function updateChecklistProgress(item, el) {
  const foot = el.querySelector(':scope > .chk-foot');
  if (!foot) return;
  const done = item.rows.filter(r => r.done).length;
  // A "0 of 1 done" counter under a single row is pure noise.
  foot.hidden = item.rows.length < 2;
  foot.textContent = `${done} of ${item.rows.length} done`;
  el.classList.toggle('all-done', item.rows.length > 0 && done === item.rows.length);
}

function buildChecklistRow(item, el, row, index) {
  const wrap = document.createElement('div');
  wrap.className = 'chk-row' + (row.done ? ' done' : '');

  const box = document.createElement('button');
  box.type = 'button';
  box.className = 'chk-box';
  box.setAttribute('aria-pressed', String(!!row.done));
  box.title = 'Toggle';
  // Ticking a box is a single click, always — it never needs the editor.
  box.addEventListener('pointerdown', (e) => e.stopPropagation());
  box.addEventListener('click', (e) => {
    e.stopPropagation();
    pushHistory();
    row.done = !row.done;
    wrap.classList.toggle('done', row.done);
    box.setAttribute('aria-pressed', String(row.done));
    updateChecklistProgress(item, el);
    markDirty();
  });

  const txt = document.createElement('div');
  txt.className = 'chk-text';
  txt.contentEditable = 'false';
  txt.spellcheck = false;
  txt.textContent = row.text || '';
  txt.dataset.empty = row.text ? 'false' : 'true';

  let coalesce = null;
  txt.addEventListener('input', () => {
    row.text = readEditable(txt);
    txt.dataset.empty = row.text ? 'false' : 'true';
    markDirty();
    scheduleLinkDraw();
    clearTimeout(coalesce);
    coalesce = setTimeout(pushHistory, 900);
  });
  txt.addEventListener('dblclick', (e) => { e.stopPropagation(); beginEdit(item, txt); });
  txt.addEventListener('blur', () => scheduleEndEdit(item));
  txt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      pushHistory();
      item.rows.splice(index + 1, 0, newRow());
      markDirty();
      renderChecklistRows(item, el, index + 1);
    } else if (e.key === 'Backspace' && !row.text && item.rows.length > 1) {
      // Backspace on an empty row removes it and puts you at the end of the
      // previous one, the way a list in any editor behaves.
      e.preventDefault();
      pushHistory();
      item.rows.splice(index, 1);
      markDirty();
      renderChecklistRows(item, el, Math.max(0, index - 1));
    }
  });

  wrap.append(box, txt);
  return wrap;
}

// --- field (a named variable with a per-box value) ---
function buildField(item) {
  const el = document.createElement('div');
  el.className = 'card field';
  applyCardColor(el, item);

  const row = document.createElement('div');
  row.className = 'fld-row';

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'fld-name';
  const varName = item.varId ? variableName(item.varId) : null;
  if (!varName) el.classList.add('unset');
  name.textContent = varName || 'Choose variable…';
  name.title = 'Pick which variable this box shows';
  name.addEventListener('pointerdown', (e) => e.stopPropagation());
  name.addEventListener('click', (e) => {
    e.stopPropagation();
    openVariablePicker(name, (varId) => {
      pushHistory();
      item.varId = varId;
      markDirty();
      renderItems();
      selectItem(item.id);
    });
  });

  // The value half is a slot: normally a text field, but it hosts a box
  // instead when one has been dropped in.
  const slot = document.createElement('div');
  slot.className = 'fld-slot';

  const child = fieldChild(item);
  if (child) {
    el.classList.add('has-child');
    slot.appendChild(buildItem(child));
  } else {
    const value = document.createElement('div');
    value.className = 'fld-value';
    value.contentEditable = 'false';
    value.spellcheck = false;
    value.textContent = item.value || '';
    value.dataset.empty = item.value ? 'false' : 'true';

    let coalesce = null;
    value.addEventListener('input', () => {
      item.value = readEditable(value);
      value.dataset.empty = item.value ? 'false' : 'true';
      markDirty();
      clearTimeout(coalesce);
      coalesce = setTimeout(pushHistory, 900);
    });
    value.addEventListener('dblclick', (e) => { e.stopPropagation(); beginEdit(item, value); });
    value.addEventListener('blur', () => scheduleEndEdit(item));
    value.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); value.blur(); }
    });
    slot.appendChild(value);
  }

  row.append(name, slot);
  el.appendChild(row);
  return el;
}

// --- page link ---
// A pointer to another page. The label is yours to rename; the subtitle
// always shows where it actually points, so a renamed link is never a
// mystery.
function buildPageLink(item) {
  const el = document.createElement('div');
  el.className = 'card pagelink';
  applyCardColor(el, item);

  const target = item.target ? findPage(item.target) : null;
  if (item.target && !target) el.classList.add('broken');

  const main = document.createElement('div');
  main.className = 'pl-main';

  const icon = document.createElement('span');
  icon.className = 'pl-icon';
  icon.innerHTML =
    target && item.anchor
      ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>'
    : target
      ? '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1"/></svg>';
  if (target) icon.style.color = target.section.color;

  const label = document.createElement('div');
  label.className = 'pl-label';
  label.contentEditable = 'false';
  label.spellcheck = false;
  label.textContent = linkLabel(item);
  label.addEventListener('input', () => {
    item.label = readEditable(label).trim() || null;
    markDirty();
  });
  label.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (item.target) beginEdit(item, label);
    else openPickerFor(item, el);
  });
  label.addEventListener('blur', () => scheduleEndEdit(item));
  label.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); label.blur(); }
  });

  main.append(icon, label);

  if (target) {
    const open = document.createElement('button');
    open.className = 'pl-open';
    open.type = 'button';
    open.title = item.anchor ? 'Jump to that block' : 'Open this page';
    open.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 17L17 7"/><path d="M9 7h8v8"/></svg>';
    open.addEventListener('pointerdown', (e) => e.stopPropagation());
    open.addEventListener('click', (e) => { e.stopPropagation(); followLink(item); });
    main.appendChild(open);
  }

  const pick = document.createElement('button');
  pick.className = 'pl-pick';
  pick.type = 'button';
  pick.title = item.target ? 'Point at a different page' : 'Choose a page';
  pick.textContent = item.target ? 'Change' : 'Choose a page…';
  pick.addEventListener('pointerdown', (e) => e.stopPropagation());
  pick.addEventListener('click', (e) => { e.stopPropagation(); openPickerFor(item, el); });

  const sub = document.createElement('div');
  sub.className = 'pl-sub';
  if (!target) {
    sub.textContent = item.target ? 'That page no longer exists' : 'Not linked yet';
  } else if (item.anchor) {
    const block = target.page.items.find(i => i.id === item.anchor);
    sub.textContent = block
      ? `${target.section.name} › ${target.page.title} › ${blockLabel(block)}`
      : `${target.section.name} › ${target.page.title} · that block is gone`;
    if (!block) el.classList.add('stale-anchor');
  } else {
    sub.textContent = `${target.section.name} › ${target.page.title}`;
  }

  el.append(main, sub, pick);
  return el;
}

// Open a link: switch to its page, and if it names a block, centre and flash
// that block so you land on the thing itself rather than somewhere on a page.
function followLink(item) {
  if (!goToPage(item.target)) return false;
  if (item.anchor) requestAnimationFrame(() => revealItem(item.anchor));
  return true;
}

// What a link box calls itself when you haven't renamed it: the block it
// points at if it names one, otherwise the page.
function linkLabel(item) {
  if (item.label) return item.label;
  const hit = item.target ? findPage(item.target) : null;
  if (!hit) return 'Untitled link';
  if (item.anchor) {
    const block = hit.page.items.find(i => i.id === item.anchor);
    if (block) return blockLabel(block);
  }
  return hit.page.title;
}

function openPickerFor(item, el) {
  openPagePicker(el, (pageId, anchor) => {
    pushHistory();
    item.target = pageId;
    item.anchor = anchor || null;
    recordLinkTarget(pageId, anchor);
    markDirty();
    renderItems();
    selectItem(item.id);
  }, (pageId) => {
    pushHistory();
    startBlockPick(item, pageId);
  });
}

// --- image ---
function buildImage(item) {
  const el = document.createElement('div');
  el.className = 'image-item';

  // An empty frame you can place now and fill in later.
  if (!item.src) {
    el.classList.add('empty');
    const add = document.createElement('button');
    add.className = 'img-add';
    add.type = 'button';
    add.title = 'Add a picture';
    add.textContent = '+';
    add.addEventListener('pointerdown', (e) => e.stopPropagation());
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      pendingImageItem = item;
      pendingImagePoint = null;
      filePicker.click();
    });
    const hint = document.createElement('div');
    hint.className = 'img-hint';
    hint.textContent = 'Click + or drop a picture here';
    el.append(add, hint);
    return el;
  }

  const img = document.createElement('img');
  // The desktop build serves images over its own inknote-img:// protocol; the
  // web build hands back a blob URL for the same id. Either way the model
  // stores one opaque reference.
  img.src = (window.api.imageUrl && window.api.imageUrl(item.src)) || item.src;
  img.alt = '';
  img.draggable = false;
  img.addEventListener('load', () => {
    // First load after a paste: adopt the natural aspect ratio.
    if (!item.h && img.naturalWidth) {
      item.h = Math.round((item.w || DEFAULTS.image.w) * img.naturalHeight / img.naturalWidth);
      el.style.height = item.h + 'px';
      markDirty();
      scheduleLinkDraw();
    }
  });
  el.appendChild(img);
  return el;
}

// --- column / row ---
// One builder for both: a column stacks its children, a row sets them side by
// side. Everything else — the collapse toggle, the drop body, the count — is
// identical, so the two stay in step by construction.
function buildContainer(item, horizontal) {
  const page = activePage();
  const el = document.createElement('div');
  el.className = horizontal ? 'column rowbox' : 'column';

  if (item.collapsed) el.classList.add('collapsed');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'col-toggle';
  toggle.textContent = item.collapsed ? '+' : '\u2212';   // + / minus sign
  toggle.title = item.collapsed ? 'Expand' : 'Collapse';
  toggle.setAttribute('aria-expanded', String(!item.collapsed));
  toggle.addEventListener('pointerdown', (e) => e.stopPropagation());
  toggle.addEventListener('click', (e) => { e.stopPropagation(); toggleColumn(item); });

  const head = document.createElement('div');
  head.className = 'col-head';
  head.contentEditable = 'false';
  head.spellcheck = false;
  head.textContent = item.title || (horizontal ? 'Row' : 'Column');
  head.addEventListener('input', () => { item.title = readEditable(head).trim(); markDirty(); });
  head.addEventListener('dblclick', (e) => { e.stopPropagation(); beginEdit(item); });
  head.addEventListener('blur', () => scheduleEndEdit(item));
  head.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); head.blur(); } });

  const body = document.createElement('div');
  body.className = 'col-body';
  for (const child of childrenOf(page, item.id)) {
    body.appendChild(buildItem(child));
  }

  // Direct children only. A row of four columns reads as "4 items", not as
  // the twenty boxes buried inside them — the nested counts are shown on the
  // nested headers, where they belong.
  const count = document.createElement('span');
  count.className = 'col-count';
  const n = childrenOf(page, item.id).length;
  count.textContent = n ? `${n} item${n === 1 ? '' : 's'}` : 'empty';

  const bar = document.createElement('div');
  bar.className = 'col-bar';
  bar.append(toggle, head, count);

  el.append(bar, body);
  return el;
}

// Collapsing is a view preference, so it's saved but deliberately kept out of
// the undo stack — Ctrl+Z should walk back your edits, not your folding.
function toggleColumn(item) {
  item.collapsed = !item.collapsed;
  markDirty();
  renderItems();
  selectItem(item.id);
}

// Anything hidden inside a collapsed column can't be measured, so arrows to it
// attach to the column instead of collapsing to a point at the origin.
function linkEndpointEl(id) {
  const el = elMap.get(id);
  if (!el) return null;
  return el.closest('.column.collapsed') || el;
}

// Opens every collapsed column between an item and the board, so revealing a
// link's target actually shows it.
function expandAncestors(itemId) {
  const page = activePage();
  if (!page) return false;
  let changed = false;
  let cur = page.items.find(i => i.id === itemId);
  while (cur && cur.parent) {
    const parent = page.items.find(i => i.id === cur.parent);
    if (!parent) break;
    if (isContainer(parent) && parent.collapsed) { parent.collapsed = false; changed = true; }
    cur = parent;
  }
  if (changed) { markDirty(); renderItems(); }
  return changed;
}

// ---------------------------------------------------------------------------
// Block picking — "open that page, then click the block I mean"
// ---------------------------------------------------------------------------
// The whole point is that it survives navigating to another page, so the
// state lives here rather than in a closure on the link box.
let blockPick = null;   // { linkId, linkPageId, targetPageId }
const blockPickBar = $('#blockPickBar');

function startBlockPick(linkItem, targetPageId) {
  blockPick = {
    linkId: linkItem.id,
    linkPageId: activePage().id,
    targetPageId
  };
  goToPage(targetPageId);
  setTool('select');            // items must be clickable, so no ink tool
  blockPickBar.hidden = false;
  const hit = findPage(targetPageId);
  $('#blockPickWhat').textContent = hit ? hit.page.title : 'this page';
  goHome();   // frame the page's contents so the boxes are in view to pick
}

function cancelBlockPick(silent) {
  if (!blockPick) return;
  const back = blockPick.linkPageId;
  blockPick = null;
  blockPickBar.hidden = true;
  if (!silent) goToPage(back);
}

// anchorId null means "just the page, no particular block".
function finishBlockPick(anchorId) {
  if (!blockPick) return;
  const { linkId, linkPageId, targetPageId } = blockPick;
  blockPick = null;
  blockPickBar.hidden = true;

  const home = findPage(linkPageId);
  const link = home && home.page.items.find(i => i.id === linkId);
  if (link) {
    link.target = targetPageId;
    link.anchor = anchorId || null;
    recordLinkTarget(targetPageId, anchorId);
    markDirty();
  }
  goToPage(linkPageId);
  if (link) selectItem(link.id);
}

$('#blockPickCancel').addEventListener('click', () => cancelBlockPick());
$('#blockPickWhole').addEventListener('click', () => finishBlockPick(null));

// Pan/zoom the board so an item is centred, then flash it — used when you
// follow a link that points at one particular block.
function revealItem(itemId) {
  expandAncestors(itemId);
  const el = elMap.get(itemId);
  if (!el) return false;
  const r = worldRect(el);
  const view = stage.getBoundingClientRect();
  cam.x = r.x + r.w / 2 - view.width  / (2 * cam.scale);
  cam.y = r.y + r.h / 2 - view.height / (2 * cam.scale);
  drawAll();
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
  return true;
}

// A short human name for a block, for the link box's subtitle.
function blockLabel(item) {
  if (!item) return null;
  const clip = (t, n = 32) => {
    const s = (t || '').trim().replace(/\s+/g, ' ');
    return s.length > n ? s.slice(0, n) + '…' : s;
  };
  if (item.type === 'card')      return clip(item.text) || 'an empty card';
  if (item.type === 'checklist') {
    const first = (item.rows || []).find(r => r.text && r.text.trim());
    return first ? clip(first.text) : 'a checklist';
  }
  if (isContainer(item))         return clip(item.title) || (item.type === 'row' ? 'a row' : 'a column');
  if (item.type === 'image')     return 'an image';
  if (item.type === 'link')      return clip(item.label) || 'a link';
  if (item.type === 'field') {
    const n = item.varId ? variableName(item.varId) : null;
    const kid = fieldChild(item);
    const shown = kid ? blockLabel(kid) : (clip(item.value, 20) || '—');
    return n ? `${n}: ${shown}` : 'a field';
  }
  return 'a block';
}

// ---------------------------------------------------------------------------
// Context menu — right-click actions for the sidebar
// ---------------------------------------------------------------------------
const ctxMenu = $('#ctxMenu');

function openContextMenu(clientX, clientY, actions) {
  ctxMenu.innerHTML = '';
  for (const a of actions) {
    if (a.separator) {
      const hr = document.createElement('div');
      hr.className = 'ctx-sep';
      ctxMenu.appendChild(hr);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (a.danger ? ' danger' : '');
    b.textContent = a.label;
    if (a.disabled) {
      b.disabled = true;
    } else {
      b.addEventListener('click', () => { closeContextMenu(); a.run(); });
    }
    ctxMenu.appendChild(b);
  }

  ctxMenu.hidden = false;
  const w = ctxMenu.offsetWidth || 170;
  const h = ctxMenu.offsetHeight || 90;
  ctxMenu.style.left = Math.min(clientX, window.innerWidth  - w - 8) + 'px';
  ctxMenu.style.top  = Math.min(clientY, window.innerHeight - h - 8) + 'px';
}

function closeContextMenu() { ctxMenu.hidden = true; }

window.addEventListener('pointerdown', (e) => {
  if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) closeContextMenu();
}, true);
window.addEventListener('blur', closeContextMenu);

// ---------------------------------------------------------------------------
// Page picker — a small search-and-choose popover for link boxes
// ---------------------------------------------------------------------------
const picker       = $('#pagePicker');
const pickerSearch = $('#pagePickerSearch');
const pickerList   = $('#pagePickerList');
let pickerChoose = null;
let pickerPickBlock = null;

function openPagePicker(anchorEl, onChoose, onPickBlock) {
  pickerChoose = onChoose;
  pickerPickBlock = onPickBlock || null;
  pickerSearch.value = '';
  renderPickerList('');
  picker.hidden = false;

  // Position under the anchor, nudged back inside the window if it would
  // hang off the edge.
  const a = anchorEl.getBoundingClientRect();
  const w = picker.offsetWidth || 280;
  const h = picker.offsetHeight || 320;
  let left = a.left;
  let top  = a.bottom + 6;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
  picker.style.left = Math.max(8, left) + 'px';
  picker.style.top  = top + 'px';

  pickerSearch.focus();
}

function closePagePicker() {
  picker.hidden = true;
  pickerChoose = null;
  pickerPickBlock = null;
}

function renderPickerList(query) {
  const q = query.trim().toLowerCase();
  const pages = allPageChoices().filter(c =>
    !q || c.title.toLowerCase().includes(q) || c.section.toLowerCase().includes(q));
  const blocks = blockChoices(query);

  pickerList.innerHTML = '';

  if (!pages.length && !blocks.length) {
    const li = document.createElement('li');
    li.className = 'picker-empty';
    li.textContent = q ? 'Nothing matches' : 'No pages yet';
    pickerList.appendChild(li);
    return;
  }

  const heading = (text) => {
    const li = document.createElement('li');
    li.className = 'picker-head';
    li.textContent = text;
    pickerList.appendChild(li);
  };

  let first = true;
  const markFirst = (li) => { if (first) { li.classList.add('active'); first = false; } };

  if (pages.length) {
    if (blocks.length) heading('Pages');
    for (const c of pages) {
      const li = document.createElement('li');
      li.dataset.id = c.id;
      markFirst(li);

      const dot = document.createElement('span');
      dot.className = 'swatch';
      dot.style.background = c.color;

      const text = document.createElement('span');
      text.className = 'picker-text';
      const title = document.createElement('span');
      title.className = 'picker-title';
      title.textContent = c.title;
      const sec = document.createElement('span');
      sec.className = 'picker-section';
      sec.textContent = c.section;
      text.append(title, sec);

      li.append(dot, text);

      if (pickerPickBlock) {
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'picker-go';
        go.textContent = 'Go to page';
        go.title = 'Open this page and click the block to link to';
        go.addEventListener('click', (e) => {
          e.stopPropagation();
          const fn = pickerPickBlock;
          closePagePicker();
          fn(c.id);
        });
        li.appendChild(go);
      }

      li.addEventListener('click', () => choosePage(c.id));
      pickerList.appendChild(li);
    }
  }

  // Blocks you've linked to before, or that match what you typed — so a
  // target you've used once is reachable by name from then on.
  if (blocks.length) {
    heading(q ? 'Blocks' : 'Recently linked');
    for (const b of blocks) {
      const li = document.createElement('li');
      li.dataset.id = `block:${b.pageId}:${b.itemId}`;
      li.classList.add('picker-block');
      markFirst(li);

      const dot = document.createElement('span');
      dot.className = 'swatch';
      dot.style.background = b.color;

      const text = document.createElement('span');
      text.className = 'picker-text';
      const title = document.createElement('span');
      title.className = 'picker-title';
      title.textContent = b.label;
      const sub = document.createElement('span');
      sub.className = 'picker-section';
      sub.textContent = `${b.sectionName} › ${b.pageTitle}`;
      text.append(title, sub);

      li.append(dot, text);
      li.addEventListener('click', () => chooseBlock(b.pageId, b.itemId));
      pickerList.appendChild(li);
    }
  }
}

function choosePage(pageId) {
  const fn = pickerChoose;
  closePagePicker();
  if (fn) fn(pageId, null);
}

function chooseBlock(pageId, itemId) {
  const fn = pickerChoose;
  closePagePicker();
  if (fn) fn(pageId, itemId);
}

// Rows carry either a page id or "block:<page>:<item>".
function commitPickerRow(rowId) {
  if (!rowId) return;
  if (rowId.startsWith('block:')) {
    const [, pageId, itemId] = rowId.split(':');
    chooseBlock(pageId, itemId);
  } else {
    choosePage(rowId);
  }
}

// Search box behaviour shared by every popover chooser: type to filter,
// arrows to move the highlight, Enter to take it, Escape to back out.
function wireChooserInput(input, list, { onFilter, onEnter, onClose }) {
  input.addEventListener('input', () => onFilter(input.value));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the board's shortcuts must not fire while typing here
    const rows = Array.from(list.querySelectorAll('li[data-id]'));
    const idx = rows.findIndex(li => li.classList.contains('active'));

    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      onEnter(rows[idx] ? rows[idx].dataset.id : null, input.value);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      const next = e.key === 'ArrowDown'
        ? Math.min(rows.length - 1, idx + 1)
        : Math.max(0, idx - 1);
      rows.forEach(li => li.classList.remove('active'));
      rows[next].classList.add('active');
      rows[next].scrollIntoView({ block: 'nearest' });
    }
  });
}

wireChooserInput(pickerSearch, pickerList, {
  onFilter: (v) => renderPickerList(v),
  onEnter: (id) => commitPickerRow(id),
  onClose: closePagePicker
});

// Clicking anywhere else dismisses it.
window.addEventListener('pointerdown', (e) => {
  if (picker.hidden) return;
  if (!picker.contains(e.target)) closePagePicker();
}, true);

// ---------------------------------------------------------------------------
// Variable picker — search, pick, create, delete
// ---------------------------------------------------------------------------
const varPicker  = $('#varPicker');
const varSearch  = $('#varPickerSearch');
const varList    = $('#varPickerList');
let varChoose = null;

function openVariablePicker(anchorEl, onChoose) {
  varChoose = onChoose;
  varSearch.value = '';
  renderVariableList('');
  varPicker.hidden = false;

  const a = anchorEl.getBoundingClientRect();
  const w = varPicker.offsetWidth || 280;
  const h = varPicker.offsetHeight || 300;
  let left = a.left;
  let top = a.bottom + 6;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
  varPicker.style.left = Math.max(8, left) + 'px';
  varPicker.style.top = top + 'px';

  varSearch.focus();
}

function closeVariablePicker() {
  varPicker.hidden = true;
  varChoose = null;
}

function chooseVariable(id) {
  const fn = varChoose;
  closeVariablePicker();
  if (fn) fn(id);
}

// Enter creates the typed name when nothing matches it exactly.
function commitVariableSearch(highlightedId, text) {
  const typed = (text || '').trim();
  if (typed && !findVariableByName(typed)) {
    const made = createVariable(typed);
    if (made) { chooseVariable(made.id); return; }
  }
  if (typed) {
    const exact = findVariableByName(typed);
    if (exact) { chooseVariable(exact.id); return; }
  }
  if (highlightedId) chooseVariable(highlightedId);
}

function renderVariableList(query) {
  const q = query.trim().toLowerCase();
  const rows = sortedVariables().filter(v => !q || v.name.toLowerCase().includes(q));

  varList.innerHTML = '';

  rows.forEach((v, i) => {
    const li = document.createElement('li');
    li.dataset.id = v.id;
    if (i === 0) li.classList.add('active');

    const name = document.createElement('span');
    name.className = 'picker-title';
    name.textContent = v.name;

    const used = fieldsUsingVariable(v.id).length;
    const count = document.createElement('span');
    count.className = 'var-count';
    count.textContent = used ? `${used} box${used === 1 ? '' : 'es'}` : 'unused';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'var-del';
    del.textContent = '×';
    del.title = 'Delete this variable';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeVariablePicker();
      const n = fieldsUsingVariable(v.id).length;
      const ok = await confirmDelete({
        title: 'Delete variable?',
        body: n
          ? `Delete “${v.name}”? ${n} box${n === 1 ? '' : 'es'} use${n === 1 ? 's' : ''} it — they'll keep their values but go back to asking for a variable.`
          : `Delete the variable “${v.name}”?`
      });
      if (ok) deleteVariable(v.id);
    });

    li.append(name, count, del);
    li.addEventListener('click', () => chooseVariable(v.id));
    varList.appendChild(li);
  });

  const typed = query.trim();
  if (typed && !findVariableByName(typed)) {
    const make = document.createElement('li');
    make.className = 'var-create';
    make.textContent = `Create “${typed}”`;
    make.addEventListener('click', () => {
      const made = createVariable(typed);
      if (made) chooseVariable(made.id);
    });
    varList.appendChild(make);
  } else if (!rows.length) {
    const empty = document.createElement('li');
    empty.className = 'picker-empty';
    empty.textContent = 'No variables yet — type a name to make one';
    varList.appendChild(empty);
  }
}

wireChooserInput(varSearch, varList, {
  onFilter: (v) => renderVariableList(v),
  onEnter: (id, text) => commitVariableSearch(id, text),
  onClose: closeVariablePicker
});

window.addEventListener('pointerdown', (e) => {
  if (varPicker.hidden) return;
  if (!varPicker.contains(e.target)) closeVariablePicker();
}, true);

// ---------------------------------------------------------------------------
// Item interaction: select, drag, drop into columns
// ---------------------------------------------------------------------------
// Right-clicking blank board offers to paste, and to build something here.
stage.addEventListener('contextmenu', (e) => {
  if (blockPick) return;
  if (e.target.closest('.item')) return;   // the item's own menu handles that
  e.preventDefault();
  const w = toWorld(e.clientX, e.clientY);

  openContextMenu(e.clientX, e.clientY, [
    boardClipboard
      ? { label: 'Paste here', run: () => pasteClipboard(w) }
      : { label: 'Nothing copied yet', disabled: true, run: () => {} },
    { separator: true },
    { label: 'New card here', run: () => { setTool('card'); addCard(w.x, w.y); } },
    { label: 'New checklist here', run: () => { setTool('checklist'); addChecklist(w.x, w.y); } },
    { label: 'New column here', run: () => { setTool('column'); addColumn(w.x, w.y); } },
    { label: 'New row here', run: () => { setTool('row'); addRow(w.x, w.y); } },
    { separator: true },
    { label: 'Re-centre on my work', run: () => goHome() }
  ]);
});

function openItemMenu(clientX, clientY, item) {
  const actions = [];

  const fieldHosting = item.type === 'field' && fieldChild(item);
  if (['card', 'checklist', 'link', 'field'].includes(item.type) && !fieldHosting) {
    actions.push({ label: item.type === 'field' ? 'Edit value' : 'Edit text',
                   run: () => beginEdit(item) });
  }
  if (fieldHosting) {
    actions.push({ label: 'Take the box out', run: () => detachFieldChild(item) });
  }
  if (item.type === 'field') {
    actions.push({ label: 'Change variable…', run: () => {
      const el = elMap.get(item.id);
      const btn = el && el.querySelector('.fld-name');
      if (btn) btn.click();
    } });
    if (item.varId) {
      actions.push({ label: 'Rename variable…', run: () => promptRenameVariable(item.varId) });
    }
  }
  if (item.type === 'link') {
    actions.push({ label: 'Change target…', run: () => {
      const el = elMap.get(item.id);
      if (el) openPickerFor(item, el);
    } });
  }
  if (item.type === 'image') {
    actions.push({ label: item.src ? 'Replace picture…' : 'Add a picture…', run: () => {
      pendingImageItem = item;
      pendingImagePoint = null;
      filePicker.click();
    } });
  }

  if (isContainer(item)) {
    actions.push({ label: item.collapsed ? 'Expand' : 'Collapse',
                   run: () => toggleColumn(item) });
  }
  const many = selection.size > 1 && selection.has(item.id);
  const n = selectionRoots().length;
  actions.push({ label: many ? `Copy ${n} boxes` : 'Copy',
                 run: () => (many ? copySelection() : copyItem(item)) });
  actions.push({ label: many ? `Duplicate ${n} boxes` : 'Duplicate',
                 run: () => (many ? duplicateSelection() : duplicateItem(item)) });
  actions.push({ label: 'Bring to front', run: () => bringToFront(item) });
  actions.push({ separator: true });
  actions.push({ label: many ? `Delete ${n} boxes` : 'Delete', danger: true,
                 run: () => (many ? deleteSelection() : requestDeleteItem(item)) });

  openContextMenu(clientX, clientY, actions);
}

// Pops a hosted box back onto the board beside its field, so you can get it
// out without a precise drag.
function detachFieldChild(field) {
  const kid = fieldChild(field);
  if (!kid) return;
  const el = elMap.get(kid.id);
  const at = el ? worldRect(el) : { x: field.x, y: field.y };
  pushHistory();
  kid.parent = null;
  kid.x = Math.round(at.x);
  kid.y = Math.round(at.y + 60);
  renderItems();
  selectItem(kid.id);
  markDirty();
}

// Duplicates everything selected in one step, keeping the copies selected so
// you can immediately drag the new group somewhere.
function duplicateSelection() {
  const roots = selectionRoots();
  if (!roots.length) return null;
  if (roots.length === 1) return duplicateItem(roots[0]);

  const copies = roots.map(r => duplicateItem(r)).filter(Boolean);
  selection.clear();
  copies.forEach(c => selection.add(c.id));
  selectedItemId = copies.length ? copies[copies.length - 1].id : null;
  paintSelection();
  return copies[0] || null;
}

async function deleteSelection() {
  const roots = selectionRoots();
  if (!roots.length) return;
  if (roots.length === 1) { await requestDeleteItem(roots[0]); return; }

  const total = roots.reduce((n, r) => n + descendantIds(r.id).size, 0);
  const ok = await confirmDelete({
    title: 'Delete selection?',
    body: total > roots.length
      ? `Delete ${roots.length} boxes and the ${total - roots.length} item${total - roots.length === 1 ? '' : 's'} inside them? You can undo this with Ctrl+Z.`
      : `Delete ${roots.length} boxes? You can undo this with Ctrl+Z.`
  });
  if (!ok) return;

  pushHistory();
  for (const r of roots) removeItem(r, { silent: true });
}

// Stacking order follows array order, so "front" means last.
function bringToFront(item) {
  const page = activePage();
  const subtree = descendantIds(item.id);
  const moving = page.items.filter(i => subtree.has(i.id));
  if (!moving.length) return;
  pushHistory();
  page.items = page.items.filter(i => !subtree.has(i.id)).concat(moving);
  renderItems();
  selectItem(item.id);
  markDirty();
}

function paintSelection() {
  for (const [id, el] of elMap) el.classList.toggle('selected', selection.has(id));
  const n = selection.size;
  selectionLabel.textContent = n > 1 ? `${n} selected` : '';
}

function selectItem(id) {
  clearLinkSelection();
  selection.clear();
  selectedItemId = id || null;
  if (id) selection.add(id);
  paintSelection();
}

// Ctrl/Cmd-click: add to or remove from the selection.
function toggleSelect(id) {
  if (!id) return;
  clearLinkSelection();
  if (selection.has(id)) {
    selection.delete(id);
    if (selectedItemId === id) selectedItemId = [...selection].pop() || null;
  } else {
    selection.add(id);
    selectedItemId = id;
  }
  paintSelection();
}

function clearSelection() {
  selection.clear();
  selectedItemId = null;
  paintSelection();
}

// Every selected item, in page order.
function selectedItems() {
  const page = activePage();
  if (!page) return [];
  return page.items.filter(i => selection.has(i.id));
}

// The outermost selected items: if a column and something inside it are both
// selected, only the column is a root. Stops nested items being acted on twice.
function selectionRoots() {
  const page = activePage();
  if (!page) return [];
  const inSelection = (item) => {
    let cur = item;
    while (cur && cur.parent) {
      if (selection.has(cur.parent)) return true;
      cur = page.items.find(i => i.id === cur.parent);
    }
    return false;
  };
  return selectedItems().filter(i => !inSelection(i));
}

function onItemPointerDown(e, item, el) {
  e.stopPropagation();

  // Picking a block beats every other interaction.
  if (blockPick) {
    if (e.button !== 0) return;
    e.preventDefault();
    finishBlockPick(item.id);
    return;
  }

  // Only the left button interacts with a box. Middle is a pan (handled
  // before this ever runs) and right opens the menu via `contextmenu`.
  if (e.button !== 0) return;

  if (tool.name === 'arrow') {
    e.preventDefault();
    handleArrowClick(item);
    return;
  }

  if (INK_TOOLS.has(tool.name)) return; // ink passes through (pointer-events: none)

  // A creation tool clicked on a column's open area builds the new item
  // inside that column — including another column.
  const intoField = item.type === 'field' && !fieldChild(item)
    && (e.target.classList.contains('fld-slot') || e.target.classList.contains('fld-value'));
  if (CREATE_TOOLS.has(tool.name) && (
        (isContainer(item) && e.target.classList.contains('col-body')) || intoField)) {
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    const made = createItem(tool.name, w.x, w.y);
    if (made) {
      dropIntoColumn(made, item, { x: e.clientX, y: e.clientY });
      renderItems();
      selectItem(made.id);
      markDirty();
    }
    return;
  }

  // Clicking a different item closes any open editor first.
  if (editingItemId && editingItemId !== item.id) stopEditing();

  if (e.ctrlKey || e.metaKey) {
    // Ctrl-click builds up a selection; it never starts a drag, or every
    // add-to-selection would nudge the box.
    e.preventDefault();
    toggleSelect(item.id);
    return;
  }

  // Clicking something already in a multi-selection keeps the selection, so
  // you can grab the group and move it.
  if (!(selection.size > 1 && selection.has(item.id))) selectItem(item.id);

  // While text is being edited the pointer belongs to the caret, not to a
  // drag. Otherwise the whole item body drags.
  if (editingItemId !== item.id) startItemDrag(e, item, el);
}

// Drags only start once the pointer has actually moved. Without this, a plain
// click would preventDefault and swallow the dblclick that opens the editor.
function startItemDrag(e, item, el) {
  const originX = e.clientX, originY = e.clientY;
  let ctx = null;

  const move = (ev) => {
    if (!ctx) {
      if (Math.hypot(ev.clientX - originX, ev.clientY - originY) < 3) return;
      ctx = beginItemDrag(item, el, toWorld(originX, originY));
    }
    ctx.move(ev);
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (ctx) ctx.up(ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function beginItemDrag(item, el, startWorld) {
  pushHistory();

  // Dragging one member of a multi-selection moves the group. Only free
  // boxes travel — anything living inside a container keeps its slot, since
  // "move it, but also somewhere in a list" has no sensible answer.
  const group = (selection.size > 1 && selection.has(item.id))
    ? selectionRoots().filter(i => i.id !== item.id && !i.parent)
    : [];
  const groupStart = group.map(i => ({ item: i, x: i.x, y: i.y }));

  const wasInColumn = item.parent || null;

  // Pull the item out of its column into free space so it can follow the
  // cursor anywhere; if it lands back in a column we re-parent on drop.
  if (wasInColumn) {
    const r = worldRect(el);
    item.parent = null;
    item.x = r.x;
    item.y = r.y;
    item.w = item.w || Math.round(r.w);
    itemsLayer.appendChild(el);
    el.style.left = item.x + 'px';
    el.style.top = item.y + 'px';
    el.style.width = item.w + 'px';
  }

  const ox = item.x, oy = item.y;
  let hoverCol = null;

  const onMove = (ev) => {
    const w = toWorld(ev.clientX, ev.clientY);
    const dx = w.x - startWorld.x;
    const dy = w.y - startWorld.y;
    item.x = ox + dx;
    item.y = oy + dy;
    el.style.left = item.x + 'px';
    el.style.top  = item.y + 'px';

    for (const g of groupStart) {
      g.item.x = g.x + dx;
      g.item.y = g.y + dy;
      const ge = elMap.get(g.item.id);
      if (ge) { ge.style.left = g.item.x + 'px'; ge.style.top = g.item.y + 'px'; }
    }

    let col = columnUnder(ev.clientX, ev.clientY, item);
    // A field holds exactly one box, so it isn't a target for a group.
    if (group.length && col && col.type === 'field') col = null;
    if (col !== hoverCol) {
      if (hoverCol && elMap.has(hoverCol.id)) elMap.get(hoverCol.id).classList.remove('drop-target');
      hoverCol = col;
      if (hoverCol && elMap.has(hoverCol.id)) elMap.get(hoverCol.id).classList.add('drop-target');
    }
    scheduleLinkDraw();
  };

  const onUp = (ev) => {
    if (hoverCol && elMap.has(hoverCol.id)) elMap.get(hoverCol.id).classList.remove('drop-target');
    if (hoverCol) {
      const dropping = orderForDrop([item, ...group], hoverCol);
      dropManyIntoColumn(dropping, hoverCol, { x: ev.clientX, y: ev.clientY });
      renderItems();
      // Keep the group selected so it can be nudged again straight away.
      selection.clear();
      dropping.forEach(d => selection.add(d.id));
      selectedItemId = item.id;
      paintSelection();
    }
    markDirty();
    scheduleLinkDraw();
  };

  return { move: onMove, up: onUp };
}

function columnUnder(clientX, clientY, moving) {
  const page = activePage();
  // A container can't be dropped into itself or into anything it contains.
  const forbidden = moving
    ? (isContainer(moving) ? descendantIds(moving.id) : new Set([moving.id]))
    : new Set();

  let best = null;
  let bestDepth = -1;

  for (const col of page.items) {
    if (!holdsChildren(col) || forbidden.has(col.id)) continue;
    const el = elMap.get(col.id);
    if (!el) continue;
    if (col.collapsed) continue;                       // folded: nothing to drop into
    if (col.type === 'field' && fieldChild(col)) continue;  // its one slot is taken

    // :scope > matters now that containers nest — otherwise an outer one
    // would measure its inner one's body.
    const body = dropSlot(el, col);
    if (!body) continue;
    const r = body.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) continue;

    // Prefer the innermost column the pointer is over.
    let depth = 0;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.classList && (p.classList.contains('column') || p.classList.contains('field'))) depth++;
    }
    if (depth > bestDepth) { best = col; bestDepth = depth; }
  }
  return best;
}

// `point` is the pointer in client coordinates; a column compares against each
// sibling's horizontal midline, a row against its vertical one.
function dropIntoColumn(item, col, point) {
  return dropManyIntoColumn([item], col, point);
}

// Inserts one or more boxes into a container at the point they were dropped,
// keeping the order they arrive in.
function dropManyIntoColumn(items, col, point) {
  const page = activePage();
  if (!items.length) return false;

  // A field has a single slot — no ordering to work out, and no room for a
  // group.
  if (col.type === 'field') {
    if (fieldChild(col) || items.length > 1) return false;
    items[0].parent = col.id;
    items[0].order = 0;
    return true;
  }

  const moving = new Set(items.map(i => i.id));
  const siblings = childrenOf(page, col.id).filter(c => !moving.has(c.id));
  const horizontal = col.type === 'row';

  let index = siblings.length;
  if (point) {
    for (let i = 0; i < siblings.length; i++) {
      const el = elMap.get(siblings[i].id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const past = horizontal
        ? point.x < r.left + r.width / 2
        : point.y < r.top + r.height / 2;
      if (past) { index = i; break; }
    }
  }

  items.forEach(it => { it.parent = col.id; });
  siblings.splice(index, 0, ...items);
  siblings.forEach((c, i) => { c.order = i; });
  return true;
}

// What order a group lands in.
//
//   1. All from the same container -> the order they already had in it.
//   2. All loose on the board      -> the order they read on the board:
//                                     top-to-bottom for a column, left-to-
//                                     right for a row.
//   3. Mixed origins               -> the order you ctrl-clicked them, which
//                                     is the only thing they have in common.
function orderForDrop(roots, container) {
  if (roots.length < 2) return roots.slice();
  const parents = new Set(roots.map(r => r.parent || null));

  if (parents.size === 1) {
    const from = [...parents][0];
    if (from) return roots.slice().sort((a, b) => (a.order || 0) - (b.order || 0));

    const horizontal = container && container.type === 'row';
    return roots.slice().sort((a, b) => horizontal
      ? (a.x - b.x) || (a.y - b.y)
      : (a.y - b.y) || (a.x - b.x));
  }

  const clicked = [...selection];
  return roots.slice().sort((a, b) => clicked.indexOf(a.id) - clicked.indexOf(b.id));
}

// ---------------------------------------------------------------------------
// Duplicating items
// ---------------------------------------------------------------------------
// Copies an item with everything it owns: a column brings its whole nested
// subtree, and any arrows running between copied items are recreated between
// the copies rather than left pointing back at the originals.
function duplicateItem(item) {
  const page = activePage();
  if (!page || !item) return null;

  const subtree = descendantIds(item.id);
  const originals = page.items.filter(i => subtree.has(i.id));
  const idMap = new Map();

  const clones = originals.map(src => {
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = uid();
    idMap.set(src.id, copy.id);
    return copy;
  });

  for (const copy of clones) {
    // Re-point parents at the copied container. The root keeps whatever
    // container the original sat in.
    if (copy.parent && idMap.has(copy.parent)) copy.parent = idMap.get(copy.parent);
  }

  const root = clones[originals.findIndex(o => o.id === item.id)];

  pushHistory();

  if (item.parent) {
    // Inside a column: land immediately after the original.
    root.parent = item.parent;
    root.order = (item.order || 0) + 0.5;
  } else {
    // Free on the board: nudge clear of the original so both are visible.
    root.parent = null;
    root.x = (item.x || 0) + 26;
    root.y = (item.y || 0) + 26;
  }

  page.items.push(...clones);

  // Renormalise the sibling ordering so the fractional order doesn't linger.
  if (root.parent) {
    childrenOf(page, root.parent).forEach((c, i) => { c.order = i; });
  }

  // Arrows with both ends inside the copied subtree come along.
  const innerLinks = page.links.filter(l => idMap.has(l.from) && idMap.has(l.to));
  for (const l of innerLinks) {
    page.links.push({ ...l, id: uid(), from: idMap.get(l.from), to: idMap.get(l.to) });
  }

  renderItems();
  selectItem(root.id);
  markDirty();
  return root;
}

// ---------------------------------------------------------------------------
// Copy & paste
// ---------------------------------------------------------------------------
// An in-app clipboard rather than the system one: a board item is a graph of
// objects with ids, parents and arrows, and nothing outside InkNote could do
// anything with a serialised copy of it. The system clipboard still gets a
// plain-text summary so pasting into another app isn't a dead end.
let boardClipboard = null;

// Where the pointer last was over the board, so paste lands under the cursor.
let lastPointerWorld = null;
stage.addEventListener('pointermove', (e) => {
  lastPointerWorld = toWorld(e.clientX, e.clientY);
});

function copyItem(item) {
  return item ? copyItems([item]) : false;
}

// Copies one or more roots and everything they contain, plus the arrows that
// run between any of the copied boxes.
function copyItems(roots) {
  const page = activePage();
  if (!page || !roots.length) return false;

  const ids = new Set();
  for (const r of roots) for (const id of descendantIds(r.id)) ids.add(id);

  boardClipboard = {
    rootIds: roots.map(r => r.id),
    items: page.items.filter(i => ids.has(i.id)).map(i => JSON.parse(JSON.stringify(i))),
    links: page.links
      .filter(l => ids.has(l.from) && ids.has(l.to))
      .map(l => JSON.parse(JSON.stringify(l)))
  };
  return true;
}

function copySelection() {
  const roots = selectionRoots();
  return roots.length ? copyItems(roots) : false;
}

function pastePoint() {
  if (lastPointerWorld) return lastPointerWorld;
  const c = viewportCenterWorld();
  return { x: c.x - 130, y: c.y - 60 };
}

// Pastes onto whatever page is open now — the clipboard carries everything it
// needs, so it crosses pages and sections freely.
function pasteClipboard(at) {
  if (!boardClipboard) return null;
  const page = activePage();
  if (!page) return null;

  const idMap = new Map();
  const clones = boardClipboard.items.map(src => {
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = uid();
    idMap.set(src.id, copy.id);
    return copy;
  });

  for (const copy of clones) {
    // Anything whose container didn't come along becomes free-floating.
    copy.parent = copy.parent && idMap.has(copy.parent) ? idMap.get(copy.parent) : null;
  }

  const rootIds = boardClipboard.rootIds.map(id => idMap.get(id)).filter(Boolean);
  const roots = clones.filter(c => rootIds.includes(c.id));
  if (!roots.length) return null;

  pushHistory();

  // Anchor the group by its top-left corner so the boxes keep their relative
  // positions instead of all landing on top of each other.
  const originals = boardClipboard.rootIds
    .map(id => boardClipboard.items.find(i => i.id === id))
    .filter(Boolean);
  const minX = Math.min(...originals.map(i => i.x || 0));
  const minY = Math.min(...originals.map(i => i.y || 0));

  const pt = at || pastePoint();
  roots.forEach((r, i) => {
    r.parent = null;
    const src = originals[i] || { x: minX, y: minY };
    r.x = Math.round(pt.x + ((src.x || 0) - minX));
    r.y = Math.round(pt.y + ((src.y || 0) - minY));
  });
  const root = roots[0];

  page.items.push(...clones);
  for (const l of boardClipboard.links) {
    page.links.push({ ...l, id: uid(), from: idMap.get(l.from), to: idMap.get(l.to) });
  }

  renderItems();
  selection.clear();
  roots.forEach(r => selection.add(r.id));
  selectedItemId = root.id;
  paintSelection();
  markDirty();
  return root;
}

// ---------------------------------------------------------------------------
// Deleting items (with confirmation when there's something to lose)
// ---------------------------------------------------------------------------
function itemIsEmpty(item) {
  const page = activePage();
  if (item.type === 'card')      return !item.text || !item.text.trim();
  if (item.type === 'checklist') return !(item.rows || []).some(r => r.text && r.text.trim());
  if (item.type === 'image')  return !item.src;
  if (item.type === 'link')   return !item.target;
  if (item.type === 'field')  return !item.varId && !(item.value || '').trim() && !fieldChild(item);
  if (isContainer(item))      return descendantIds(item.id).size === 1;
  return true;
}

function describeItem(item) {
  const page = activePage();
  if (item.type === 'card') {
    const t = (item.text || '').trim().replace(/\s+/g, ' ');
    return t.length > 60 ? `“${t.slice(0, 60)}…”` : `“${t}”`;
  }
  if (item.type === 'checklist') {
    const rows = (item.rows || []).filter(r => r.text && r.text.trim());
    const first = rows.length ? rows[0].text.trim() : '';
    const rest = rows.length > 1 ? ` and ${rows.length - 1} more item${rows.length === 2 ? '' : 's'}` : '';
    return `the checklist “${first.length > 40 ? first.slice(0, 40) + '…' : first}”${rest}`;
  }
  if (item.type === 'link') return `the link “${linkLabel(item)}”`;
  if (item.type === 'field') {
    const n = item.varId ? variableName(item.varId) : null;
    const kid = fieldChild(item);
    const tail = kid ? ' and the box inside it' : '';
    return (n ? `the “${n}” field` : 'this field') + tail;
  }
  if (item.type === 'image') return 'this image';
  if (isContainer(item)) {
    const n = descendantIds(item.id).size - 1; // everything that would go with it
    const kind = item.type === 'row' ? 'row' : 'column';
    const name = item.title || (item.type === 'row' ? 'Row' : 'Column');
    return `the ${kind} “${name}” and the ${n} item${n === 1 ? '' : 's'} inside it`;
  }
  return 'this item';
}

async function promptRenameVariable(id) {
  const v = variableById(id);
  if (!v) return;
  const next = await promptText({
    title: 'Rename variable',
    body: 'This renames it in every box that uses it. The values stay put.',
    value: v.name,
    okLabel: 'Rename'
  });
  if (next === null || !next.trim() || next.trim() === v.name) return;

  if (!renameVariable(id, next)) {
    await openModal({
      title: 'Name already taken',
      body: `There's already a variable called “${next.trim()}”.`,
      okLabel: 'OK',
      danger: false
    });
  }
}

async function requestDeleteItem(item) {
  if (!itemIsEmpty(item)) {
    const ok = await confirmDelete({
      title: item.type === 'column' ? 'Delete column?' : 'Delete item?',
      body: `Delete ${describeItem(item)}? You can undo this with Ctrl+Z.`
    });
    if (!ok) return;
  }
  pushHistory();
  removeItem(item);
}

// Is this image file referenced by anything other than the items being
// deleted? Checks the whole notebook, since a page can be duplicated too.
function imageStillUsed(src, excludeIds) {
  const skip = new Set(excludeIds);
  for (const sec of notebook.sections) {
    for (const pg of sec.pages) {
      for (const it of pg.items) {
        if (it.type === 'image' && it.src === src && !skip.has(it.id)) return true;
      }
    }
  }
  return false;
}

function removeItem(item, opts = {}) {
  const page = activePage();
  if (!page) return;

  // Deleting a column takes everything nested under it, however deep.
  const doomed = Array.from(descendantIds(item.id));

  // Duplicated image boxes share one file on disk, so only delete the file
  // once nothing else in the notebook still points at it.
  const dyingSrcs = doomed
    .map(id => page.items.find(i => i.id === id))
    .filter(it => it && it.type === 'image' && it.src)
    .map(it => it.src);

  for (const src of new Set(dyingSrcs)) {
    if (!imageStillUsed(src, doomed)) window.api.deleteImage(src);
  }

  page.items = page.items.filter(i => !doomed.includes(i.id));
  page.links = page.links.filter(l => !doomed.includes(l.from) && !doomed.includes(l.to));

  // Any link box anywhere in the notebook that anchored to a deleted block
  // drops back to pointing at the page as a whole.
  for (const sec of notebook.sections) {
    for (const pg of sec.pages) {
      for (const it of pg.items) {
        if (it.type === 'link' && it.anchor && doomed.includes(it.anchor)) it.anchor = null;
      }
    }
  }

  doomed.forEach(id => selection.delete(id));
  if (doomed.includes(selectedItemId)) selectedItemId = [...selection].pop() || null;
  renderItems();
  if (!opts.silent) markDirty();
  else markDirty();
}

// ---------------------------------------------------------------------------
// Links (arrows)
// ---------------------------------------------------------------------------
function handleArrowClick(item) {
  const page = activePage();
  if (!linkSourceId) {
    linkSourceId = item.id;
    if (elMap.has(item.id)) elMap.get(item.id).classList.add('link-source');
    linkHint.hidden = false;
    return;
  }
  if (linkSourceId === item.id) { cancelLinking(); return; }

  const exists = page.links.some(l =>
    (l.from === linkSourceId && l.to === item.id) ||
    (l.from === item.id && l.to === linkSourceId));

  if (!exists) {
    pushHistory();
    page.links.push({ id: uid(), from: linkSourceId, to: item.id, color: tool.color });
    markDirty();
  }
  cancelLinking();
  scheduleLinkDraw();
}

function cancelLinking() {
  if (linkSourceId && elMap.has(linkSourceId)) {
    elMap.get(linkSourceId).classList.remove('link-source');
  }
  linkSourceId = null;
  linkHint.hidden = true;
}

function clearLinkSelection() {
  if (!selectedLinkId) return;
  const g = linkPaths.querySelector(`g[data-id="${selectedLinkId}"]`);
  if (g) g.classList.remove('selected');
  selectedLinkId = null;
}

function worldRect(el) {
  const r = el.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  return {
    x: (r.left - s.left) / cam.scale + cam.x,
    y: (r.top  - s.top)  / cam.scale + cam.y,
    w: r.width  / cam.scale,
    h: r.height / cam.scale
  };
}

// Walk out from the rect's centre toward the target and stop at the border,
// so arrows touch the edge of a card rather than burying themselves in it.
function edgePoint(rect, tx, ty) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx ? (rect.w / 2) / Math.abs(dx) : Infinity;
  const sy = dy ? (rect.h / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return { x: cx + dx * t, y: cy + dy * t };
}

let linkFrame = null;
function scheduleLinkDraw() {
  if (linkFrame) return;
  linkFrame = requestAnimationFrame(() => { linkFrame = null; drawLinks(); });
}

function drawLinks() {
  linkPaths.innerHTML = '';
  const page = activePage();
  if (!page) return;

  for (const link of page.links) {
    const a = linkEndpointEl(link.from);
    const b = linkEndpointEl(link.to);
    if (!a || !b || a === b) continue;

    const ra = worldRect(a), rb = worldRect(b);
    const ca = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 };
    const cb = { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 };
    const p1 = edgePoint(ra, cb.x, cb.y);
    const p2 = edgePoint(rb, ca.x, ca.y);

    // Bow the line slightly so two arrows between the same pair stay legible.
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(28, len * 0.12);
    const qx = mx - (dy / len) * bow;
    const qy = my + (dx / len) * bow;
    const d = `M ${p1.x} ${p1.y} Q ${qx} ${qy} ${p2.x} ${p2.y}`;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.dataset.id = link.id;
    if (link.id === selectedLinkId) g.classList.add('selected');

    // A fat invisible path under the visible one gives the arrow a
    // comfortable click target without making the line itself thick.
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'hit');
    hit.setAttribute('vector-effect', 'non-scaling-stroke');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'link');
    path.setAttribute('stroke', link.color || '#7d766c');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('marker-end', 'url(#arrowhead)');
    path.setAttribute('vector-effect', 'non-scaling-stroke');

    hit.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      clearSelection();
      clearLinkSelection();
      selectedLinkId = link.id;
      g.classList.add('selected');
    });

    g.append(hit, path);
    linkPaths.appendChild(g);
  }
}

function deleteSelectedLink() {
  const page = activePage();
  if (!selectedLinkId || !page) return;
  pushHistory();
  page.links = page.links.filter(l => l.id !== selectedLinkId);
  selectedLinkId = null;
  markDirty();
  scheduleLinkDraw();
}

// ---------------------------------------------------------------------------
// Creating items
// ---------------------------------------------------------------------------
function addCard(x, y) {
  const page = activePage();
  pushHistory();
  const item = {
    id: uid(), type: 'card',
    x, y, w: DEFAULTS.card.w,
    text: '', color: tool.color === PALETTE[0] ? null : tool.color
  };
  page.items.push(item);
  renderItems();
  markDirty();
  requestAnimationFrame(() => beginEdit(item));
  return item;
}

function addChecklist(x, y) {
  const page = activePage();
  pushHistory();
  const item = {
    id: uid(), type: 'checklist',
    x, y, w: DEFAULTS.checklist.w,
    rows: [newRow()],
    color: tool.color === PALETTE[0] ? null : tool.color
  };
  page.items.push(item);
  renderItems();
  markDirty();
  requestAnimationFrame(() => beginEdit(item));
  return item;
}

function addColumn(x, y) {
  const page = activePage();
  pushHistory();
  const item = {
    id: uid(), type: 'column',
    x, y, w: DEFAULTS.column.w,
    title: 'Column'
  };
  page.items.push(item);
  renderItems();
  markDirty();
  return item;
}

const CREATE_TOOLS = new Set(['card', 'checklist', 'column', 'row', 'image', 'link', 'field']);

function createItem(toolName, x, y) {
  switch (toolName) {
    case 'card':      return addCard(x, y);
    case 'checklist': return addChecklist(x, y);
    case 'column':    return addColumn(x, y);
    case 'row':       return addRow(x, y);
    case 'image':     return addImageBox(x, y);
    case 'link':      return addPageLink(x, y);
    case 'field':     return addField(x, y);
    default:          return null;
  }
}

// A row carries no width of its own — it fits whatever is inside it.
function addRow(x, y) {
  const page = activePage();
  pushHistory();
  const item = { id: uid(), type: 'row', x, y, title: 'Row' };
  page.items.push(item);
  renderItems();
  selectItem(item.id);
  markDirty();
  return item;
}

function addImageBox(x, y) {
  const page = activePage();
  pushHistory();
  const item = {
    id: uid(), type: 'image',
    x, y, w: DEFAULTS.image.w, h: DEFAULTS.image.h,
    src: null
  };
  page.items.push(item);
  renderItems();
  selectItem(item.id);
  markDirty();
  return item;
}

function addField(x, y) {
  const page = activePage();
  pushHistory();
  const item = {
    id: uid(), type: 'field',
    x, y, w: DEFAULTS.field.w,
    varId: null, value: '',
    color: tool.color === PALETTE[0] ? null : tool.color
  };
  page.items.push(item);
  renderItems();
  selectItem(item.id);
  markDirty();
  // A field with no variable says nothing, so go straight to picking one.
  requestAnimationFrame(() => {
    const el = elMap.get(item.id);
    const btn = el && el.querySelector('.fld-name');
    if (btn) btn.click();
  });
  return item;
}

function addPageLink(x, y) {
  const page = activePage();
  pushHistory();
  const item = {
    id: uid(), type: 'link',
    x, y, w: DEFAULTS.link.w,
    target: null, label: null,
    color: tool.color === PALETTE[0] ? null : tool.color
  };
  page.items.push(item);
  renderItems();
  selectItem(item.id);
  markDirty();
  // Straight into the picker — an unlinked link box is useless.
  requestAnimationFrame(() => {
    const el = elMap.get(item.id);
    if (el) openPickerFor(item, el);
  });
  return item;
}

async function addImageFromDataUrl(dataUrl, x, y) {
  const res = await window.api.saveImage(dataUrl);
  if (!res || !res.ok) {
    console.error('Image save failed:', res && res.error);
    return null;
  }
  const page = activePage();
  pushHistory();
  const item = { id: uid(), type: 'image', x, y, w: DEFAULTS.image.w, src: res.url };
  page.items.push(item);
  renderItems();
  markDirty();
  return item;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

// Hidden picker for the image tool — Electron lets a plain file input do the
// work, so no extra IPC is needed here.
const filePicker = document.createElement('input');
filePicker.type = 'file';
filePicker.accept = 'image/*';
filePicker.style.display = 'none';
document.body.appendChild(filePicker);

let pendingImagePoint = null;
let pendingImageItem = null;

filePicker.addEventListener('change', async () => {
  const file = filePicker.files && filePicker.files[0];
  filePicker.value = '';
  const target = pendingImageItem;
  const pt = pendingImagePoint;
  pendingImageItem = null;
  pendingImagePoint = null;
  if (!file) return;

  const dataUrl = await readFileAsDataUrl(file);
  if (target) await attachImage(target, dataUrl);
  else {
    const at = pt || viewportCenterWorld();
    await addImageFromDataUrl(dataUrl, at.x, at.y);
  }
});

// Fill an empty image frame (or replace what's in one).
async function attachImage(item, dataUrl) {
  const res = await window.api.saveImage(dataUrl);
  if (!res || !res.ok) {
    console.error('Image save failed:', res && res.error);
    return false;
  }
  pushHistory();
  if (item.src) window.api.deleteImage(item.src);
  item.src = res.url;
  delete item.h; // recompute from the picture's own aspect ratio on load
  renderItems();
  selectItem(item.id);
  markDirty();
  return true;
}

// Ctrl+C: copy the selected box, unless a caret is in a text field — then
// the browser's own copy is what you meant.
window.addEventListener('copy', (e) => {
  if (editingItemId || isEditingText()) return;
  const roots = selectionRoots();
  if (!roots.length) return;
  const item = roots[0];
  if (!copyItems(roots)) return;
  e.preventDefault();
  // Give other apps something readable, even though we paste the real thing
  // from our own clipboard.
  try {
    const summary = roots.length > 1
      ? roots.map(r => blockLabel(r)).filter(Boolean).join('\n')
      : (blockLabel(item) || 'InkNote item');
    e.clipboardData.setData('text/plain', summary);
  } catch {}
});

// Ctrl+V: an image on the system clipboard wins; otherwise paste our box.
window.addEventListener('paste', async (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (items) {
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        e.preventDefault();
        const file = it.getAsFile();
        if (!file) return;
        const pt = pastePoint();
        await addImageFromDataUrl(await readFileAsDataUrl(file), pt.x, pt.y);
        return;
      }
    }
  }
  if (editingItemId || isEditingText()) return;  // typing: let text paste
  if (!boardClipboard) return;
  e.preventDefault();
  pasteClipboard();
});

function isEditingText() {
  const a = document.activeElement;
  return !!a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
}

// Drag an image file in from Explorer.
stage.addEventListener('dragover', (e) => { e.preventDefault(); });
stage.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;

  // Dropped onto an empty image frame? Fill that one instead of making a new.
  const frame = e.target.closest && e.target.closest('.image-item.empty');
  if (frame) {
    const item = itemById(frame.dataset.id);
    const file = Array.from(files).find(f => f.type.startsWith('image/'));
    if (item && file) { await attachImage(item, await readFileAsDataUrl(file)); return; }
  }

  const pt = toWorld(e.clientX, e.clientY);
  let offset = 0;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    await addImageFromDataUrl(await readFileAsDataUrl(file), pt.x + offset, pt.y + offset);
    offset += 24;
  }
});

// ---------------------------------------------------------------------------
// Pointer interaction on the stage
// ---------------------------------------------------------------------------
let drawing = null;
let panning = null;
let spaceDown = false;
let erasedAny = false;

function setTool(name) {
  if (INK_TOOLS.has(tool.name) && tool.memory[tool.name]) {
    tool.memory[tool.name] = { color: tool.color, size: tool.size };
  }
  tool.name = name;
  const mem = tool.memory[name];
  if (mem) { tool.color = mem.color; tool.size = mem.size; }

  if (name !== 'arrow') cancelLinking();

  $$('#toolbar .tool[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === name));

  for (const t of ['select', 'card', 'checklist', 'column', 'row', 'image', 'link', 'field', 'arrow']) {
    stage.classList.toggle('tool-' + t, name === t);
  }
  overlay.classList.toggle('ink-mode', INK_TOOLS.has(name));

  sizeRange.value = tool.size;
  sizeRange.disabled = !INK_TOOLS.has(name);
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

function startPan(e) {
  panning = { startX: e.clientX, startY: e.clientY, camX: cam.x, camY: cam.y };
  stage.classList.add('panning');
  try { stage.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
  e.preventDefault();
}

// Middle button is *only* ever a camera pan. Caught in the capture phase and
// stopped there, so it can never reach a box and be mistaken for a drag —
// including when the press lands on a small control like a collapse toggle.
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 1) return;
  e.stopPropagation();
  startPan(e);
}, true);

// Chromium's middle-click autoscroll would fight the pan.
stage.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

stage.addEventListener('pointerdown', (e) => {
  // While picking a block, blank board is for getting around, not for
  // committing. Left-drag pans, so you can go and find the box you want
  // without a stray click linking the whole page by accident.
  if (blockPick && !e.target.closest('.item')) {
    if (e.button === 0) startPan(e);
    return;
  }
  if (e.target.closest('.item')) return; // items handle themselves

  // Pan with space held. (Middle button is handled in the capture phase.)
  if (spaceDown && e.button === 0) { startPan(e); return; }

  if (e.button !== 0) return;
  const page = activePage();
  if (!page) return;
  const w = toWorld(e.clientX, e.clientY);

  if (CREATE_TOOLS.has(tool.name)) { clearSelection(); createItem(tool.name, w.x, w.y); return; }
  if (tool.name === 'arrow')  { cancelLinking(); return; }
  if (tool.name === 'select') {
    if (!(e.ctrlKey || e.metaKey)) { clearSelection(); clearLinkSelection(); }
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

  if (drawing.tool === 'highlighter') {
    drawAll(); // multiply blending needs a clean redraw to avoid stacking
  } else {
    paintStroke({ ...drawing, points: pts.slice(-3) });
  }
});

function endPointer() {
  if (panning) {
    panning = null;
    stage.classList.remove('panning');
    return;
  }
  if (!drawing) return;

  if (drawing.erasing) {
    if (!erasedAny) {
      // Nothing was erased — drop the history entry we optimistically pushed.
      stackFor(activePage().id).undo.pop();
      refreshHistoryButtons();
    } else {
      markDirty();
    }
  } else {
    markDirty();
    drawAll();
  }
  drawing = null;
}

stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('pointerleave', () => { if (drawing || panning) endPointer(); });

// Stroke-level erase, the way OneNote's stroke eraser works: touch any part
// of a stroke and the whole stroke goes.
function eraseAt(w) {
  const page = activePage();
  const r = Math.max(4, tool.size / 2);
  const before = page.strokes.length;
  page.strokes = page.strokes.filter(s => !strokeHit(s, w, r + s.size / 2));
  if (page.strokes.length !== before) {
    erasedAny = true;
    drawAll();
  }
}

function strokeHit(s, w, radius) {
  const pts = s.points;
  if (pts.length === 1) return Math.hypot(pts[0][0] - w.x, pts[0][1] - w.y) <= radius;
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

// Ctrl+wheel zooms; plain wheel pans, matching OneNote/Figma.
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
// Page / section rendering
// ---------------------------------------------------------------------------
function renderPageContent() {
  clearSelection();
  clearLinkSelection();
  cancelLinking();
  renderItems();
  drawAll();
  const page = activePage();
  if (page) pageLabel.textContent = `${activeSection().name} › ${page.title}`;
  refreshHistoryButtons();
}

// The delete flows are shared by the × button and the right-click menu, so
// the two can never drift apart.
async function deleteSectionFlow(sec) {
  if (notebook.sections.length === 1) {
    await confirmDelete({
      title: 'Can’t delete',
      body: 'This is your last section — a notebook needs at least one.',
      okLabel: 'OK'
    });
    return;
  }
  const n = sec.pages.length;
  const ok = await confirmDelete({
    title: 'Delete section?',
    body: `Delete “${sec.name}” and the ${n} page${n === 1 ? '' : 's'} inside it? This can’t be undone.`
  });
  if (!ok) return;

  notebook.sections = notebook.sections.filter(s => s.id !== sec.id);
  sec.pages.forEach(p => history.stacks.delete(p.id));
  if (notebook.activeSectionId === sec.id) {
    notebook.activeSectionId = notebook.sections[0].id;
    notebook.activePageId = notebook.sections[0].pages[0].id;
  }
  markDirty(); renderSidebar(); renderPageContent();
}

async function deletePageFlow(sec, pg) {
  if (sec.pages.length === 1) {
    await confirmDelete({
      title: 'Can’t delete',
      body: 'This is the last page in the section — a section needs at least one.',
      okLabel: 'OK'
    });
    return;
  }
  const count = pg.items.length + pg.strokes.length;
  const ok = await confirmDelete({
    title: 'Delete page?',
    body: count
      ? `Delete “${pg.title}”? It has ${count} item${count === 1 ? '' : 's'} on it. This can’t be undone.`
      : `Delete “${pg.title}”? This can’t be undone.`
  });
  if (!ok) return;

  sec.pages = sec.pages.filter(p => p.id !== pg.id);
  history.stacks.delete(pg.id);
  if (notebook.activePageId === pg.id) notebook.activePageId = sec.pages[0].id;
  markDirty(); renderSidebar(); renderPageContent();
}

// Renaming is wired by delegation on the <ul>, not on each row. Selecting a
// row re-renders the list, which swaps the row elements out between the two
// clicks of a double-click — a listener bound to the row itself would be on a
// dead node by the time the second click landed.
function beginSidebarRename(li) {
  if (!li) return;
  const label = li.querySelector('.label');
  if (!label) return;

  if (li.dataset.kind === 'section') {
    const sec = notebook.sections.find(x => x.id === li.dataset.id);
    if (!sec) return;
    startRename(label, (v) => {
      sec.name = v; markDirty(); renderSidebar(); renderPageContent();
    });
  } else {
    const hit = findPage(li.dataset.id);
    if (!hit) return;
    startRename(label, (v) => {
      hit.page.title = v; markDirty(); renderSidebar();
      pageLabel.textContent = `${hit.section.name} › ${hit.page.title}`;
    });
  }
}

sectionList.addEventListener('dblclick', (e) => {
  if (e.target.closest('.del')) return;
  beginSidebarRename(e.target.closest('li'));
});
pageList.addEventListener('dblclick', (e) => {
  if (e.target.closest('.del')) return;
  beginSidebarRename(e.target.closest('li'));
});

function renderSidebar() {
  // --- sections ---
  sectionList.innerHTML = '';
  notebook.sections.forEach(sec => {
    const li = document.createElement('li');
    li.className = sec.id === notebook.activeSectionId ? 'active' : '';
    li.dataset.kind = 'section';
    li.dataset.id = sec.id;
    li.title = 'Double-click to rename · right-click for more · drag to reorder';

    const dot = document.createElement('span');
    dot.className = 'swatch';
    dot.style.background = sec.color;

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = sec.name;

    const renameSection = () => beginSidebarRename(li);

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete section';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteSectionFlow(sec); });

    li.append(dot, label, del);

    li.addEventListener('click', () => {
      // Already here: leave the DOM alone so a double-click can land.
      if (notebook.activeSectionId === sec.id) return;
      notebook.activeSectionId = sec.id;
      if (!sec.pages.length) sec.pages.push(blankPage());
      notebook.activePageId = sec.pages[0].id;
      markDirty(); renderSidebar(); renderPageContent();
    });

    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, [
        { label: 'Rename', run: renameSection },
        { label: 'New page in this section', run: () => {
            notebook.activeSectionId = sec.id;
            addPage();
          } },
        { separator: true },
        { label: 'Delete section', danger: true, run: () => deleteSectionFlow(sec) }
      ]);
    });

    makeReorderable(li, 'section', sec.id, (movingId, after) => {
      if (reorderById(notebook.sections, movingId, sec.id, after)) {
        markDirty(); renderSidebar();
      }
    });

    // A page dropped on a section header moves to that section.
    li.addEventListener('dragover', (e) => {
      const payload = dragPayload(e);
      if (!payload || payload.kind !== 'page') return;
      e.preventDefault();
      li.classList.add('drop-into');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-into'));
    li.addEventListener('drop', (e) => {
      const payload = dragPayload(e);
      if (!payload || payload.kind !== 'page') return;
      e.preventDefault();
      e.stopPropagation();
      li.classList.remove('drop-into');
      movePageToSection(payload.id, sec);
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
    li.dataset.kind = 'page';
    li.dataset.id = pg.id;
    li.title = 'Double-click to rename · right-click for more · drag to reorder';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = pg.title;

    const renamePage = () => beginSidebarRename(li);

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete page';
    del.addEventListener('click', (e) => { e.stopPropagation(); deletePageFlow(sec, pg); });

    li.append(label, del);

    li.addEventListener('click', () => {
      if (notebook.activePageId === pg.id) return;
      notebook.activePageId = pg.id;
      markDirty(); renderSidebar(); renderPageContent();
    });

    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, [
        { label: 'Rename', run: renamePage },
        { label: 'Duplicate', run: () => duplicatePage(sec, pg) },
        { separator: true },
        { label: 'Delete page', danger: true, run: () => deletePageFlow(sec, pg) }
      ]);
    });

    makeReorderable(li, 'page', pg.id, (movingId, after) => {
      if (reorderById(sec.pages, movingId, pg.id, after)) {
        markDirty(); renderSidebar();
      }
    });

    pageList.appendChild(li);
  });
}

function movePageToSection(pageId, destSection) {
  const hit = findPage(pageId);
  if (!hit || hit.section.id === destSection.id) return;
  if (hit.section.pages.length === 1) return; // a section can't be left empty

  hit.section.pages = hit.section.pages.filter(p => p.id !== pageId);
  destSection.pages.push(hit.page);
  notebook.activeSectionId = destSection.id;
  notebook.activePageId = hit.page.id;
  markDirty(); renderSidebar(); renderPageContent();
}

// Deep-copies a page. Item ids are regenerated and arrows remapped onto the
// new ids, so the copy's connections point inside the copy.
function duplicatePage(sec, pg) {
  const clone = JSON.parse(JSON.stringify(pg));
  clone.id = uid();
  clone.title = pg.title + ' copy';

  const idMap = new Map();
  clone.items.forEach(it => { const fresh = uid(); idMap.set(it.id, fresh); it.id = fresh; });
  clone.items.forEach(it => { if (it.parent) it.parent = idMap.get(it.parent) || null; });
  clone.links = (clone.links || [])
    .map(l => ({ ...l, id: uid(), from: idMap.get(l.from), to: idMap.get(l.to) }))
    .filter(l => l.from && l.to);
  clone.strokes.forEach(st => { st.id = uid(); });

  const at = sec.pages.findIndex(p => p.id === pg.id);
  sec.pages.splice(at + 1, 0, clone);
  notebook.activePageId = clone.id;
  markDirty(); renderSidebar(); renderPageContent();
}

// Move `movingId` next to `targetId` inside `arr`. Returns whether anything
// actually changed, so a no-op drag doesn't dirty the file.
function reorderById(arr, movingId, targetId, placeAfter) {
  if (movingId === targetId) return false;
  const from = arr.findIndex(x => x.id === movingId);
  if (from < 0) return false;

  const before = arr.map(x => x.id).join();
  const [moved] = arr.splice(from, 1);
  const to = arr.findIndex(x => x.id === targetId);
  if (to < 0) { arr.splice(from, 0, moved); return false; }
  arr.splice(placeAfter ? to + 1 : to, 0, moved);
  return arr.map(x => x.id).join() !== before;
}

// Wires one sidebar row for drag-to-reorder. `kind` keeps pages from being
// dropped into the sections list and vice versa.
function makeReorderable(li, kind, id, onDrop) {
  li.draggable = true;

  li.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${kind}:${id}`);
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    clearDropMarkers();
  });

  li.addEventListener('dragover', (e) => {
    const payload = dragPayload(e);
    if (!payload || payload.kind !== kind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    clearDropMarkers();
    li.classList.add(after ? 'drop-after' : 'drop-before');
  });
  li.addEventListener('dragleave', () => {
    li.classList.remove('drop-before', 'drop-after');
  });

  li.addEventListener('drop', (e) => {
    const payload = dragPayload(e);
    if (!payload || payload.kind !== kind) return;
    e.preventDefault();
    e.stopPropagation();
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    clearDropMarkers();
    onDrop(payload.id, after);
  });
}

// dragover can't read dataTransfer contents in Chromium, so the payload is
// stashed on dragstart and read back here.
let currentDrag = null;
function dragPayload(e) {
  const raw = (() => {
    try { return e.dataTransfer.getData('text/plain'); } catch { return ''; }
  })();
  const text = raw || currentDrag || '';
  const i = text.indexOf(':');
  if (i < 0) return null;
  return { kind: text.slice(0, i), id: text.slice(i + 1) };
}

function clearDropMarkers() {
  $$('.list li.drop-before, .list li.drop-after').forEach(n =>
    n.classList.remove('drop-before', 'drop-after'));
}

document.addEventListener('dragstart', (e) => {
  const li = e.target.closest && e.target.closest('.list li');
  currentDrag = li ? `${li.dataset.kind}:${li.dataset.id}` : null;
});
document.addEventListener('dragend', () => { currentDrag = null; clearDropMarkers(); });

function startRename(label, commit) {
  const original = label.textContent;
  label.contentEditable = 'true';
  label.focus();
  const range = document.createRange();
  range.selectNodeContents(label);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const row = label.closest('li');
  if (row) row.draggable = false;

  const finish = (save) => {
    label.contentEditable = 'false';
    if (row) row.draggable = true;
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
  const page = blankPage();
  const sec = {
    id: uid(),
    name: 'New section',
    color: SECTION_COLORS[notebook.sections.length % SECTION_COLORS.length],
    pages: [page]
  };
  notebook.sections.push(sec);
  notebook.activeSectionId = sec.id;
  notebook.activePageId = page.id;
  markDirty(); renderSidebar(); renderPageContent();
}

function addPage() {
  const sec = activeSection();
  const pg = blankPage();
  sec.pages.push(pg);
  notebook.activePageId = pg.id;
  markDirty(); renderSidebar(); renderPageContent();
}

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------
PALETTE.forEach(c => {
  const b = document.createElement('button');
  b.className = 'swatch-btn';
  b.dataset.color = c;
  b.style.background = c;
  b.title = c;
  b.addEventListener('click', () => {
    tool.color = c;
    if (tool.memory[tool.name]) tool.memory[tool.name].color = c;

    // With a card selected, the swatch recolours that card instead of just
    // arming the next one — that's what you almost always mean.
    const tintable = selectedItems().filter(i =>
      ['card', 'checklist', 'link', 'field'].includes(i.type));
    if (tintable.length) {
      pushHistory();
      for (const it of tintable) {
        it.color = (c === PALETTE[0]) ? null : c;
        applyCardColor(elMap.get(it.id), it);
      }
      markDirty();
    } else if (selectedLinkId) {
      const page = activePage();
      const link = page.links.find(l => l.id === selectedLinkId);
      if (link) { pushHistory(); link.color = c; markDirty(); scheduleLinkDraw(); }
    }
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
$('#homeBtn').addEventListener('click', () => goHome());

$('#exportBtn').addEventListener('click', () => window.api.exportNotebook(notebook));

// ---- shared rooms (web build only; absent on desktop) ---------------------
const shareBtn = $('#shareBtn');
if (shareBtn && window.INKNOTE_SYNC && window.INKNOTE_SYNC.configured) {
  shareBtn.hidden = false;
  shareBtn.addEventListener('click', async () => {
    const already = window.INKNOTE_SYNC.inRoom();
    shareBtn.disabled = true;
    try {
      const link = await window.INKNOTE_SYNC.share(notebook);
      let copied = false;
      try { await navigator.clipboard.writeText(link); copied = true; } catch { /* denied */ }
      await openModal({
        title: already ? 'Share this room' : 'Room created',
        body: (copied ? 'Link copied to your clipboard.\n\n' : '') + link +
              '\n\nAnyone with this link can open and edit this notebook. ' +
              'Edits appear for everyone within a second.',
        okLabel: 'Done',
        danger: false
      });
    } catch (err) {
      console.error(err);
      await openModal({
        title: 'Could not create the room',
        body: String(err && err.message ? err.message : err),
        okLabel: 'OK', danger: false
      });
    } finally {
      shareBtn.disabled = false;
      shareBtn.textContent = window.INKNOTE_SYNC.inRoom() ? 'Copy link' : 'Share';
    }
  });
}
$('#importBtn').addEventListener('click', async () => {
  const res = await window.api.importNotebook();
  if (!res || !res.ok) return;
  const migrated = migrate(res.data);
  if (!migrated) return;
  const ok = await confirmDelete({
    title: 'Replace notebook?',
    body: 'Importing replaces everything currently in InkNote. Export a backup first if you need one.',
    okLabel: 'Replace'
  });
  if (!ok) return;
  notebook = migrated;
  if (!activeSection()) notebook.activeSectionId = notebook.sections[0].id;
  if (!activePage()) notebook.activePageId = activeSection().pages[0].id;
  history.stacks.clear();
  markDirty(); renderSidebar(); renderPageContent();
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
function typingInField(e) {
  const t = e.target;
  return t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
}

window.addEventListener('keydown', (e) => {
  if (!modalBackdrop.hidden) {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeModal(false); }
    if (e.key === 'Enter')  { e.preventDefault(); closeModal(true); }
    return;
  }

  if (e.code === 'Space' && !typingInField(e)) spaceDown = true;

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); persist(); return; }
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); addPage(); return; }
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();   // Chromium would otherwise try to bookmark the page
    if (editingItemId) return;   // mid-typing, this isn't what you meant
    duplicateSelection();
    return;
  }

  if (e.key === 'Home' || (mod && e.key === '0')) {
    e.preventDefault();
    goHome();
    return;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    if (!ctxMenu.hidden) { closeContextMenu(); return; }
    if (blockPick) { cancelBlockPick(); return; }
    if (!picker.hidden) { closePagePicker(); return; }
    if (!varPicker.hidden) { closeVariablePicker(); return; }
    // Step out one layer at a time: finish editing, drop a half-made arrow,
    // then fall back to the select tool.
    const wasEditing = stopEditing();
    const wasLinking = !!linkSourceId;
    cancelLinking();
    if (!wasEditing && !wasLinking && tool.name === 'select') {
      clearSelection();
      clearLinkSelection();
    }
    setTool('select');
    return;
  }
  if (typingInField(e)) return;

  const map = {
    v: 'select', c: 'card', k: 'checklist', l: 'column', r: 'row', a: 'arrow', i: 'image',
    g: 'link', f: 'field',
    p: 'pen', h: 'highlighter', e: 'eraser'
  };
  const next = map[e.key.toLowerCase()];
  if (next) { setTool(next); return; }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedLinkId) { e.preventDefault(); deleteSelectedLink(); return; }
    if (selection.size) { e.preventDefault(); deleteSelection(); }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceDown = false;
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function init() {
  const loaded = migrate(await window.api.load());
  notebook = (loaded && loaded.sections.length) ? loaded : blankNotebook();

  // Guard against a stale/missing active id in a hand-edited file.
  if (!activeSection()) notebook.activeSectionId = notebook.sections[0].id;
  if (!activePage()) notebook.activePageId = activeSection().pages[0].id;

  setTool('select');
  renderSidebar();
  resizeCanvas();
  renderPageContent();
  saveState.textContent = 'Saved';

  // If the URL names a shared room, join it — its contents replace what we
  // just loaded from local storage.
  if (window.INKNOTE_SYNC && window.INKNOTE_SYNC.configured) {
    const joined = await window.INKNOTE_SYNC.start();
    if (joined && shareBtn) shareBtn.textContent = 'Copy link';
  }
})();

// ---------------------------------------------------------------------------
// Test hooks — used only by smoke.js, harmless in the shipped app.
// ---------------------------------------------------------------------------
window.__inknote = {
  get notebook() { return notebook; },
  activePage, activeSection, itemById, childrenOf, topLevelItems,
  migrate, tint, edgePoint, dropIntoColumn, setTool, newRow, renderItems,
  findPage, allPageChoices, goToPage, attachImage, linkLabel,
  descendantIds, columnUnder, createItem,
  reorderById, movePageToSection, duplicatePage, openContextMenu, closeContextMenu,
  beginSidebarRename,
  blockLabel, revealItem, followLink, startBlockPick, finishBlockPick, cancelBlockPick,
  duplicateItem, bringToFront, openItemMenu, imageStillUsed,
  variableById, variableName, sortedVariables, findVariableByName,
  createVariable, renameVariable, deleteVariable, fieldsUsingVariable,
  openVariablePicker, closeVariablePicker, chooseVariable, commitVariableSearch,
  promptText, promptRenameVariable,
  goHome, contentBounds, cam, startPan, applyRemoteNotebook,
  reportRoomFailure: (room, err) => openModal({
    title: 'Could not open that room',
    body: `The link points at room "${room}", but joining it failed:\n\n` +
          String(err && err.message ? err.message : err) +
          '\n\nYou are looking at your own notebook instead.',
    okLabel: 'OK', danger: false
  }),
  get panning() { return panning; },
  copyItem, copyItems, copySelection, pasteClipboard,
  toggleSelect, clearSelection, selectedItems, selectionRoots,
  dropManyIntoColumn, orderForDrop,
  duplicateSelection, deleteSelection,
  get selection() { return selection; },
  toggleColumn, expandAncestors, linkEndpointEl, isContainer, addRow,
  holdsChildren, fieldChild, detachFieldChild,
  get boardClipboard() { return boardClipboard; },
  get blockPick() { return blockPick; },
  openPagePicker, closePagePicker, choosePage, chooseBlock, commitPickerRow,
  recordLinkTarget, recentLinkTargets, blockChoices,
  beginEdit, stopEditing,
  get toolName() { return tool.name; },
  get editingItemId() { return editingItemId; },
  get selectedItemId() { return selectedItemId; },
  selectItem
};
