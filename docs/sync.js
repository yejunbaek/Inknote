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
          strokes: pg.strokes || [],
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
            strokes: (doc && doc.strokes) || [],
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

  const internals = { newRoomId, roomFromUrl, roomLink, toDocs, fromDocs, diffDocs };

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
    applying: false
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

    if (seedFrom) await writeAll(seedFrom);

    const structRef = fs.doc(db, 'rooms', room, 'meta', 'structure');
    const pagesRef = fs.collection(db, 'rooms', room, 'pages');

    state.unsub.push(fs.onSnapshot(structRef, (snap) => {
      state.structure = snap.exists() ? snap.data() : null;
      pushToApp();
    }, onError));

    state.unsub.push(fs.onSnapshot(pagesRef, (snap) => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'removed') delete state.pages[ch.doc.id];
        else state.pages[ch.doc.id] = ch.doc.data();
      });
      pushToApp();
    }, onError));

    status('Shared room', 'live');
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
