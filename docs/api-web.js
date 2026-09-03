/* ==========================================================================
   InkNote — browser adapter
   --------------------------------------------------------------------------
   The desktop build gets `window.api` from Electron's preload script, backed
   by the filesystem. This file provides the same surface in a plain browser,
   backed by IndexedDB, so `src/renderer.js` runs unchanged in both.

   Everything is stored in the visitor's own browser. No account, no server,
   nothing leaves the machine.
   ========================================================================== */
(function () {
  'use strict';

  const DB_NAME = 'inknote';
  const DB_VERSION = 1;
  const STORE_KV = 'kv';        // the notebook itself
  const STORE_IMG = 'images';   // pasted pictures, as blobs

  // IndexedDB rather than localStorage: a notebook with a few pasted images
  // blows past localStorage's ~5 MB ceiling, and it stores blobs natively.
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
        if (!db.objectStoreNames.contains(STORE_IMG)) db.createObjectStore(STORE_IMG);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  let dbPromise = null;
  const db = () => (dbPromise || (dbPromise = openDb()));

  function tx(store, mode, fn) {
    return db().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const idbGet = (store, key) => tx(store, 'readonly', (s) => s.get(key));
  const idbPut = (store, key, val) => tx(store, 'readwrite', (s) => s.put(val, key));
  const idbDel = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
  const idbKeys = (store) => tx(store, 'readonly', (s) => s.getAllKeys());

  // ---- images -------------------------------------------------------------
  // The model stores an opaque `inknote-img://local/<name>` reference in both
  // builds. Here that resolves to a blob URL, minted once per image and held
  // for the life of the tab.
  const objectUrls = new Map();

  const imgName = (src) => {
    const m = /inknote-img:\/\/local\/(.+)$/.exec(src || '');
    return m ? m[1] : null;
  };

  async function primeImageUrls() {
    let keys = [];
    try { keys = (await idbKeys(STORE_IMG)) || []; } catch { return; }
    for (const key of keys) {
      if (objectUrls.has(key)) continue;
      try {
        const blob = await idbGet(STORE_IMG, key);
        if (blob) objectUrls.set(key, URL.createObjectURL(blob));
      } catch { /* skip a bad entry rather than failing the whole load */ }
    }
  }

  function dataUrlToBlob(dataUrl) {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl || '');
    if (!m) return null;
    const bytes = atob(m[2]);
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    return new Blob([buf], { type: m[1] });
  }

  const EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg'
  };

  // ---- file download / upload, standing in for the native dialogs --------
  function download(name, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        input.remove();
        resolve(file || null);
      });
      // A cancelled picker fires no event in most browsers, so the promise
      // simply never settles — which is the same as "nothing happened".
      input.click();
    });
  }

  // ---- the API ------------------------------------------------------------
  window.api = {
    async load() {
      try {
        await primeImageUrls();
        const raw = await idbGet(STORE_KV, 'notebook');
        if (!raw) return window.INKNOTE_STARTER ? window.INKNOTE_STARTER() : null;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (err) {
        console.error('Could not read your notebook:', err);
        return null;
      }
    },

    async save(data) {
      try {
        await idbPut(STORE_KV, 'notebook', JSON.stringify(data));
        return { ok: true };
      } catch (err) {
        console.error('Could not save:', err);
        return { ok: false, error: String(err) };
      }
    },

    async dataPath() { return 'this browser'; },

    async exportNotebook(data) {
      download('inknote-backup.json', JSON.stringify(data, null, 2));
      return { ok: true };
    },

    async importNotebook() {
      const file = await pickFile('application/json,.json');
      if (!file) return { ok: false, canceled: true };
      try {
        return { ok: true, data: JSON.parse(await file.text()) };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    async saveImage(dataUrl) {
      const blob = dataUrlToBlob(dataUrl);
      if (!blob) return { ok: false, error: 'Not a base64 data URL' };
      const ext = EXT[blob.type.toLowerCase()];
      if (!ext) return { ok: false, error: 'Unsupported image type: ' + blob.type };
      if (blob.size > 25 * 1024 * 1024) return { ok: false, error: 'Image too large' };

      const name = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`;
      try {
        await idbPut(STORE_IMG, name, blob);
      } catch (err) {
        return { ok: false, error: String(err) };
      }
      objectUrls.set(name, URL.createObjectURL(blob));
      return { ok: true, url: `inknote-img://local/${name}` };
    },

    imageUrl(src) {
      const name = imgName(src);
      return (name && objectUrls.get(name)) || src;
    },

    async deleteImage(url) {
      const name = imgName(url);
      if (!name) return { ok: false };
      const held = objectUrls.get(name);
      if (held) { URL.revokeObjectURL(held); objectUrls.delete(name); }
      try { await idbDel(STORE_IMG, name); } catch { return { ok: false }; }
      return { ok: true };
    },

    async readImageFile() { return { ok: false, error: 'Not available in the browser' }; },

    pathForFile() { return null; }
  };
})();
