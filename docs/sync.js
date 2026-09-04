/* ==========================================================================
   InkNote — shared rooms
   --------------------------------------------------------------------------
   A room is a notebook that lives in Firestore instead of in one browser.
   Anyone with the link opens the same notebook and sees edits within a second.

   Shape in Firestore:

     rooms/{room}                     { createdAt }
     rooms/{room}/meta/structure      { sections: [{id,name,color,pages:[id]}],
                                        variables, recentLinks }
     rooms/{room}/pages/{pageId}      { title, items, strokes, links }

   One document per page rather than one per notebook, so two people working
   on different pages never overwrite each other. Within a single page it is
   last-write-wins: two people dragging the same card at the same instant will
   see one of the two positions win. Fine-grained merging is a bigger job and
   is the obvious next step if that starts to bite.

   Without a Firebase config this file does nothing at all and InkNote stays
   entirely local.
   ========================================================================== */
(function () {
  'use strict';

  const SDK = 'https://www.gstatic.com/firebasejs/10.12.0/';

  // ---- pure helpers (also unit-tested from build/preview-web.js) ----------

  const ROOM_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes

  function newRoomId(rand = Math.random) {
    let out = '';
    for (let i = 0; i < 10; i++) out += ROOM_CHARS[Math.floor(rand() * ROOM_CHARS.length)];
    return out;
  }

  function roomFromUrl(href = location.href) {
    const m = /[#&?]room=([A-Za-z0-9_-]{4,64})/.exec(href);
    return m ? m[1] : null;
  }

  function roomLink(room, href = location.href) {
    return href.split('#')[0] + '#room=' + room;
  }

  // A stroke keeps its points as [[x, y, pressure], ...] — an array of arrays,
  // which Firestore flatly refuses to store ("Nested arrays are not
  // supported"). One page holding ink would fail the whole write, which is why
  // drawing never reached a room. Flatten to [x, y, p, x, y, p, ...] on the way
  // out and rebuild on the way back in.
  function packStroke(s) {
    const pts = s.points || [];
    if (!pts.length || !Array.isArray(pts[0])) return { ...s };   // already flat
    const flat = [];
    for (const p of pts) flat.push(p[0], p[1], p.length > 2 ? p[2] : 0.5);
    const out = { ...s, pts: flat };
    delete out.points;
    return out;
  }

  function unpackStroke(s) {
    if (!s || !Array.isArray(s.pts)) {
      // Written by an older build, or already in the app's own shape.
      return s;
    }
    const points = [];
    for (let i = 0; i + 2 < s.pts.length; i += 3) {
      points.push([s.pts[i], s.pts[i + 1], s.pts[i + 2]]);
    }
    const out = { ...s, points };
    delete out.pts;
    return out;
  }

  const packStrokes = (list) => (list || []).map(packStroke);
  const unpackStrokes = (list) => (list || []).map(unpackStroke);

  // Split a notebook into the documents that get stored.
  function toDocs(nb) {
    const pages = {};
    const structure = {
      variables: nb.variables || [],
      recentLinks: nb.recentLinks || [],
      sections: (nb.sections || []).map(sec => ({
        id: sec.id, name: sec.name, color: sec.color,
        pages: (sec.pages || []).map(p => p.id)
      }))
    };
    for (const sec of nb.sections || []) {
      for (const pg of sec.pages || []) {
        pages[pg.id] = {
          title: pg.title,
          items: pg.items || [],
          strokes: packStrokes(pg.strokes),
          links: pg.links || []
        };
      }
    }
    return { structure, pages };
  }

  // Rebuild a notebook from those documents. A page the server hasn't sent
  // yet becomes an empty placeholder rather than vanishing from the sidebar.
  function fromDocs(structure, pages) {
    if (!structure || !Array.isArray(structure.sections)) return null;
    return {
      version: 2,
      variables: structure.variables || [],
      recentLinks: structure.recentLinks || [],
      sections: structure.sections.map(sec => ({
        id: sec.id, name: sec.name, color: sec.color,
        pages: (sec.pages || []).map(pid => {
          const doc = pages[pid];
          return {
            id: pid,
            title: (doc && doc.title) || 'Untitled page',
            items: (doc && doc.items) || [],
            strokes: unpackStrokes(doc && doc.strokes),
            links: (doc && doc.links) || []
          };
        })
      }))
    };
  }

  // What actually changed since we last wrote, so a keystroke costs one small
  // write rather than re-uploading the whole notebook.
  function diffDocs(next, lastWritten) {
    const changedPages = [];
    for (const [id, doc] of Object.entries(next.pages)) {
      const json = JSON.stringify(doc);
      if (lastWritten.pages.get(id) !== json) changedPages.push([id, doc, json]);
    }
    const removedPages = [...lastWritten.pages.keys()].filter(id => !(id in next.pages));
    const structureJson = JSON.stringify(next.structure);
    return {
      changedPages,
      removedPages,
      structure: structureJson === lastWritten.structure ? null : next.structure,
      structureJson
    };
  }

  const imageIdFrom = (src) => {
    const m = /inknote-img:\/\/local\/(.+)$/.exec(src || '');
    return m ? m[1] : null;
  };

  // Every picture referenced anywhere in the notebook.
  function imageRefs(nb) {
    const out = new Set();
    for (const sec of nb.sections || []) {
      for (const pg of sec.pages || []) {
        for (const it of pg.items || []) {
          if (it.type === 'image' && it.src) {
            const id = imageIdFrom(it.src);
            if (id) out.add(id);
          }
        }
      }
    }
    return [...out];
  }

  // A Firestore document tops out at 1 MiB, and base64 inflates bytes by a
  // third — so a photo has to be shrunk before it can ride along in one.
  // Scale down, then step the quality down, until it fits.
  const MAX_CHARS = 700000;

  function shrinkDataUrl(dataUrl, maxChars = MAX_CHARS) {
    return new Promise((resolve) => {
      if (dataUrl.length <= maxChars) return resolve(dataUrl);
      const img = new Image();
      img.onload = () => {
        const type = 'image/webp';
        let scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        for (let attempt = 0; attempt < 8; attempt++) {
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * scale));
          c.height = Math.max(1, Math.round(img.naturalHeight * scale));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          const quality = Math.max(0.4, 0.85 - attempt * 0.07);
          const out = c.toDataURL(type, quality);
          if (out.length <= maxChars) return resolve(out);
          scale *= 0.8;
        }
        resolve(null);   // give up rather than write something oversized
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  const internals = { newRoomId, roomFromUrl, roomLink, toDocs, fromDocs, diffDocs,
                      imageIdFrom, imageRefs, shrinkDataUrl };

  const cfg = window.INKNOTE_FIREBASE;
  const configured = !!(cfg && cfg.apiKey && cfg.projectId);
  if (!configured) {
    window.INKNOTE_SYNC = { configured: false, internals };
    return;
  }

  // ---- live wiring --------------------------------------------------------

  let fb = null;
  const state = {
    room: null,
    unsub: [],
    structure: null,
    pages: {},
    lastWritten: { structure: null, pages: new Map() },
    writeTimer: null,
    applying: false,
    imagesInRoom: new Set(),   // ids the room already holds
    imagesSent: new Set()      // ids we've uploaded this session
  };

  async function boot() {
    if (fb) return fb;
    const [appMod, authMod, fsMod] = await Promise.all([
      import(SDK + 'firebase-app.js'),
      import(SDK + 'firebase-auth.js'),
      import(SDK + 'firebase-firestore.js')
    ]);
    const app = appMod.initializeApp(cfg);
    const auth = authMod.getAuth(app);
    // Anonymous sign-in: no account for the visitor, but the security rules
    // can still require *some* identity, which keeps drive-by writes out.
    await authMod.signInAnonymously(auth);
    fb = { fs: fsMod, db: fsMod.getFirestore(app), auth };
    return fb;
  }

  function status(text, tone) {
    const el = document.getElementById('roomChip');
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
    el.className = 'room-chip' + (tone ? ' ' + tone : '');
  }

  async function join(room, { seedFrom } = {}) {
    const { fs, db } = await boot();
    stop();
    state.room = room;
    state.pages = {};
    state.structure = null;
    state.lastWritten = { structure: null, pages: new Map() };
    state.imagesInRoom = new Set();
    state.imagesSent = new Set();

    if (seedFrom) await writeAll(seedFrom);

    const structRef = fs.doc(db, 'rooms', room, 'meta', 'structure');
    const pagesRef = fs.collection(db, 'rooms', room, 'pages');

    state.unsub.push(fs.onSnapshot(structRef, (snap) => {
      state.structure = snap.exists() ? snap.data() : null;
      pushToApp();
    }, onError));

    const imagesRef = fs.collection(db, 'rooms', room, 'images');
    state.unsub.push(fs.onSnapshot(imagesRef, async (snap) => {
      let added = false;
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed') continue;
        state.imagesInRoom.add(ch.doc.id);
        const data = ch.doc.data();
        if (!data || !data.data) continue;
        if (window.api.hasImage(`inknote-img://local/${ch.doc.id}`)) continue;
        if (await window.api.adoptImage(ch.doc.id, data.data)) added = true;
      }
      // Re-render so the <img> elements pick up their new blob URLs.
      if (added && window.__inknote) window.__inknote.renderItems();
    }, onError));

    state.unsub.push(fs.onSnapshot(pagesRef, (snap) => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'removed') delete state.pages[ch.doc.id];
        else state.pages[ch.doc.id] = ch.doc.data();
      });
      pushToApp();
    }, onError));

    status('Shared room · ' + room, 'live');
  }

  function onError(err) {
    console.error('Room sync error:', err);
    status('Sync problem', 'bad');
  }

  function pushToApp() {
    if (!state.structure) return;
    const nb = fromDocs(state.structure, state.pages);
    if (!nb) return;

    // Remember what the server has, so our own echo isn't written back.
    const docs = toDocs(nb);
    state.lastWritten.structure = JSON.stringify(docs.structure);
    state.lastWritten.pages = new Map(
      Object.entries(docs.pages).map(([id, d]) => [id, JSON.stringify(d)])
    );

    state.applying = true;
    try {
      window.__inknote.applyRemoteNotebook(nb);
    } finally {
      state.applying = false;
    }
  }

  async function writeAll(nb) {
    const { fs, db } = await boot();
    const docs = toDocs(nb);
    await fs.setDoc(fs.doc(db, 'rooms', state.room), { createdAt: Date.now() }, { merge: true });
    await fs.setDoc(fs.doc(db, 'rooms', state.room, 'meta', 'structure'), docs.structure);
    for (const [id, doc] of Object.entries(docs.pages)) {
      await fs.setDoc(fs.doc(db, 'rooms', state.room, 'pages', id), doc);
    }
    state.lastWritten.structure = JSON.stringify(docs.structure);
    state.lastWritten.pages = new Map(
      Object.entries(docs.pages).map(([i, d]) => [i, JSON.stringify(d)])
    );
    await syncImages(nb);
  }

  // Pictures live in their own documents, uploaded once. A viewer who only
  // has the reference and not the bytes simply skips — whoever added the
  // picture is the one who can upload it.
  async function syncImages(nb) {
    if (!state.room) return;
    const { fs, db } = await boot();
    for (const id of imageRefs(nb)) {
      if (state.imagesInRoom.has(id) || state.imagesSent.has(id)) continue;
      const src = `inknote-img://local/${id}`;
      if (!window.api.hasImage(src)) continue;

      const dataUrl = await window.api.imageDataUrl(src);
      if (!dataUrl) continue;
      const small = await shrinkDataUrl(dataUrl);
      if (!small) {
        console.warn('Picture too large to share:', id);
        state.imagesSent.add(id);   // don't retry it forever
        continue;
      }
      try {
        await fs.setDoc(fs.doc(db, 'rooms', state.room, 'images', id), { data: small });
        state.imagesSent.add(id);
      } catch (err) {
        onError(err);
        return;
      }
    }
  }

  async function flush(nb) {
    if (!state.room || state.applying) return;
    const { fs, db } = await boot();
    const next = toDocs(nb);
    const diff = diffDocs(next, state.lastWritten);
    if (!diff.changedPages.length && !diff.removedPages.length && !diff.structure) return;

    const batch = fs.writeBatch(db);
    for (const [id, doc] of diff.changedPages) {
      batch.set(fs.doc(db, 'rooms', state.room, 'pages', id), doc);
    }
    for (const id of diff.removedPages) {
      batch.delete(fs.doc(db, 'rooms', state.room, 'pages', id));
    }
    if (diff.structure) {
      batch.set(fs.doc(db, 'rooms', state.room, 'meta', 'structure'), diff.structure);
    }
    await batch.commit();

    for (const [id, , json] of diff.changedPages) state.lastWritten.pages.set(id, json);
    for (const id of diff.removedPages) state.lastWritten.pages.delete(id);
    state.lastWritten.structure = diff.structureJson;

    await syncImages(nb);
  }

  function stop() {
    state.unsub.forEach(fn => { try { fn(); } catch { /* already gone */ } });
    state.unsub = [];
  }

  window.INKNOTE_SYNC = {
    configured: true,
    internals,
    inRoom: () => state.room,

    // Called by the app after every local save.
    onLocalChange(nb) {
      if (!state.room || state.applying) return;
      clearTimeout(state.writeTimer);
      state.writeTimer = setTimeout(() => flush(nb).catch(onError), 400);
    },

    // Opens the room in the URL, if there is one.
    async start() {
      const room = roomFromUrl();
      if (!room) return false;
      status('Connecting…');
      try {
        await join(room);
        return true;
      } catch (err) {
        onError(err);
        // Silently showing the local notebook instead would look like the
        // link worked and the room was empty.
        if (window.__inknote && window.__inknote.reportRoomFailure) {
          window.__inknote.reportRoomFailure(room, err);
        }
        return false;
      }
    },

    // Turns the current notebook into a room and returns the link.
    async share(nb) {
      if (state.room) return roomLink(state.room);
      const room = newRoomId();
      status('Creating room…');
      await join(room, { seedFrom: nb });
      history.replaceState(null, '', roomLink(room));
      return roomLink(room);
    },

    leave() {
      stop();
      state.room = null;
      status('');
      history.replaceState(null, '', location.href.split('#')[0]);
    }
  };
})();
