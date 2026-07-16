// ui/styles.js — styles
(function (RSTR) {
  'use strict';
  const ui = RSTR.ui;

  // ---------- global style actions (committed mix + effective output) ----------
  ui.exportImage = function exportImage() {
    if (!ui.pipeline.hasImage()) return ui.showToast('Load an image first');
    ui.pipeline.applyOutput(ui.effectiveOutput());
    ui.pipeline.render(ui.state.mix, ui.state.source); // committed look (PRE, if any, is already a normal layer in ui.state.mix — see reconcilePreLayer), not the NEW-mode preview
    ui.pipeline.toBlob((blob) => {
      const ext = RSTR.preset.extForFormat(ui.effectiveOutput().format);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${ui.state.imageName}-rstr.${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
      ui.requestRender();
    }, ui.effectiveOutput());
  }

  ui.copyStyleCode = function copyStyleCode() {
    // PRE (if non-identity) is already a normal committed `preprocess` layer
    // at the front of ui.state.mix — see ui.reconcilePreLayer() — so it serializes
    // like any other layer, no separate concat needed.
    const preset = RSTR.preset.finalizePreset(ui.state.imageName, ui.state.mix, ui.effectiveOutput(), null, ui.state.source);
    const text = JSON.stringify(preset, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => ui.showToast(`Copied ${preset.id}`),
        () => {
          ui.showToast('Clipboard blocked — see console');
          console.log(text);
        }
      );
    } else {
      ui.showToast('Clipboard unavailable — see console');
      console.log(text);
    }
  }

  // Replace the current mix + output with a (validated) style and re-render.
  ui.applyStyle = function applyStyle(style) {
    const stack = RSTR.preset.stackToEditable(style.stack);
    // Legacy style codes carry a separate `pre` block that rendered FIRST —
    // convert it to an explicit head `preprocess` layer (same look).
    if (style.pre && !RSTR.preset.preIsIdentity(style.pre)) {
      stack.unshift({ effect: 'preprocess', enabled: true, params: RSTR.preset.normalizePre(style.pre) });
    }
    ui.state.mix = stack;
    ui.state.output = RSTR.preset.normalizeOutput(style.output);
    ui.state.outputEnabled = true;
    // A `preprocess` layer at the FRONT of the loaded stack IS the committed
    // PRE layer (see reconcilePreLayer) — track it as preLayerRef and mirror
    // its params into ui.state.pre so the PRE module edits it live; otherwise
    // PRE starts clean with nothing committed, same as ui.resetStyle().
    if (stack.length && stack[0].effect === 'preprocess') {
      ui.preLayerRef = stack[0];
      ui.state.pre = { ...ui.preLayerRef.params };
    } else {
      ui.preLayerRef = null;
      ui.state.pre = RSTR.preset.defaultPre();
    }
    ui.state.source = RSTR.preset.normalizeSource(style.source);
    ui.goNewMode();
    ui.buildMixList();
    ui.syncPreUI();
    ui.requestOutput();
  }

  // ---------- named Style Library ----------
  ui.buildStyleSelect = function buildStyleSelect() {
    const lib = RSTR.preset.loadStyleLibrary();
    const prev = ui.els.styleSelect.value;
    ui.els.styleSelect.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '— styles —';
    ui.els.styleSelect.appendChild(ph);
    for (const name of Object.keys(lib)) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      ui.els.styleSelect.appendChild(o);
    }
    if (prev && lib[prev]) ui.els.styleSelect.value = prev;
  }

  ui.loadSelectedStyle = function loadSelectedStyle() {
    const name = ui.els.styleSelect.value;
    if (!name) return;
    const style = RSTR.preset.loadStyleLibrary()[name];
    if (!style) return;
    ui.applyStyle(RSTR.preset.validatePreset(style));
    ui.showToast(`Loaded "${name}"`);
  }
  ui.pendingOverwrite = null;
  ui.saveStyleFlow = function saveStyleFlow() {
    ui.openInline('Style name…', ui.state.imageName || 'my-style', (text) => {
      const name = String(text).trim();
      if (!name) return 'Enter a name';
      const lib = RSTR.preset.loadStyleLibrary();
      if (name in lib && ui.pendingOverwrite !== name) {
        ui.pendingOverwrite = name;
        return `“${name}” exists — press OK again to overwrite`;
      }
      // PRE (if non-identity) is already a normal committed `preprocess`
      // layer at the front of ui.state.mix — see ui.reconcilePreLayer().
      const style = RSTR.preset.finalizePreset(name, ui.state.mix, ui.effectiveOutput(), null, ui.state.source);
      RSTR.preset.saveStyleToLibrary(name, style);
      ui.pendingOverwrite = null;
      ui.buildStyleSelect();
      ui.els.styleSelect.value = name;
      ui.showToast(`Saved style "${name}"`);
      return null;
    });
  }

  ui.deleteSelectedStyle = function deleteSelectedStyle() {
    const name = ui.els.styleSelect.value;
    if (!name) return ui.showToast('Select a saved style first');
    RSTR.preset.deleteStyleFromLibrary(name);
    ui.buildStyleSelect();
    ui.showToast(`Deleted "${name}"`);
  }

  // PASTE CODE (dedicated button) was removed 2026-07-13 — the global Ctrl+V
  // handler below (handleGlobalPaste) already runs clipboard text through
  // this exact parseStyleCode/applyStyle path from anywhere on the page, so
  // a second, always-visible button for the same action was redundant.

  // ---------- bridge to the batch engine (presets/) + whole-library backup ----------
  // The Style Library lives ONLY in localStorage — invisible to engine/rstr.js,
  // which reads presets/*.json from disk, and gone forever on a cache clear.
  // Two independent problems, two independent fixes below:
  //   A) → PRESETS writes ONE selected library style out as an engine-ready
  //      preset JSON (same shape Copy Code produces — the library entry IS
  //      already a finalizePreset() result, so this never re-serializes).
  //   B) EXPORT ALL / IMPORT round-trip the WHOLE library as one JSON file,
  //      so it survives a cache clear / moves to another machine.
  //
  // File System Access (showDirectoryPicker) is the happy path for (A): pick
  // presets/ once, persist the directory handle in IndexedDB (localStorage
  // can't hold a FileSystemHandle), and every later export writes straight in
  // with no dialog. Falls back to a plain <a download> — same JSON either way
  // — when the picker API is missing, throws, or permission is denied.
  const IDB_NAME = 'rstr-fs';
  const IDB_STORE = 'handles';
  const IDB_PRESETS_KEY = 'presetsDir';

  ui.idbOpen = function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  ui.idbGet = function idbGet(key) {
    return ui.idbOpen().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        })
    );
  }

  ui.idbSet = function idbSet(key, value) {
    return ui.idbOpen().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        })
    );
  }

  // Reuse a persisted handle when its permission is still (or newly) granted;
  // only fall back to the full native picker when there is no usable handle.
  ui.getPresetsDirHandle = async function getPresetsDirHandle() {
    if (!window.showDirectoryPicker) return null;
    let handle = null;
    try {
      handle = await ui.idbGet(IDB_PRESETS_KEY);
    } catch {
      handle = null;
    }
    if (handle) {
      try {
        let perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') return handle;
        // permission revoked and re-request declined -> re-prompt below
      } catch {
        /* stale/broken handle (e.g. folder moved) -> re-prompt below */
      }
    }
    try {
      handle = await window.showDirectoryPicker({ id: 'rstr-presets', mode: 'readwrite' });
    } catch {
      return null; // user cancelled, or the picker isn't allowed here
    }
    try {
      await ui.idbSet(IDB_PRESETS_KEY, handle);
    } catch {
      /* non-fatal -- export still works this call, just re-prompts next time */
    }
    return handle;
  }

  ui.writeJsonToDir = async function writeJsonToDir(dirHandle, filename, text) {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  ui.downloadText = function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  ui.slugify = function slugify(name) {
    const s = String(name || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s || 'style';
  }

  // A) → PRESETS — write the currently SELECTED library style to disk.
  ui.exportStyleToPresets = async function exportStyleToPresets() {
    const name = ui.els.styleSelect.value;
    if (!name) return ui.showToast('Select a saved style first');
    const style = RSTR.preset.loadStyleLibrary()[name];
    if (!style) return ui.showToast('Style not found');
    const filename = `${ui.slugify(style.name || name)}.json`;
    const text = JSON.stringify(style, null, 2);

    const dirHandle = await ui.getPresetsDirHandle();
    if (dirHandle) {
      try {
        await ui.writeJsonToDir(dirHandle, filename, text);
        ui.showToast(`Wrote presets/${filename}`);
        return;
      } catch (err) {
        console.warn('RSTR: presets/ write failed, falling back to download', err);
      }
    }
    ui.downloadText(filename, text);
    ui.showToast(`Downloaded ${filename} — drop it into presets/`);
  }

  // BACKUP disclosure (2026-07-13) — Export all/Import are needed once in a
  // blue moon, so they stay hidden behind one flat toggle button instead of
  // occupying two permanent rows in the 170px /Styles column. Same
  // ▸ collapsed / ▾ expanded glyph convention as the /Effects group headers.
  ui.toggleBackupRow = function toggleBackupRow() {
    const opening = ui.els.backupRow.style.display === 'none';
    ui.els.backupRow.style.display = opening ? 'flex' : 'none';
    ui.els.backupToggleBtn.textContent = (opening ? '▾' : '▸') + ' Backup';
  }

  // B) EXPORT ALL / IMPORT — whole-library backup + restore.
  ui.exportAllStyles = function exportAllStyles() {
    const lib = RSTR.preset.loadStyleLibrary();
    const count = Object.keys(lib).length;
    if (!count) return ui.showToast('Library is empty');
    ui.downloadText('rstr-style-library.json', JSON.stringify(lib, null, 2));
    ui.showToast(`Exported ${count} style(s)`);
  }

  // Merge an imported library into the current one via the existing
  // save/validate path (never a second serializer). On a name collision:
  // identical style (same rstr_ id) -> left alone; different style under the
  // same name -> imported under a disambiguated "name (2)" instead of
  // silently overwriting.
  ui.importLibraryFile = function importLibraryFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let incoming;
      try {
        incoming = JSON.parse(String(reader.result));
      } catch {
        ui.showToast('Not valid JSON');
        return;
      }
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        ui.showToast('Not a style library file');
        return;
      }
      let added = 0;
      let renamed = 0;
      let unchanged = 0;
      let invalid = 0;
      for (const name of Object.keys(incoming)) {
        let style;
        try {
          style = RSTR.preset.validatePreset(incoming[name]);
        } catch {
          invalid++;
          continue;
        }
        const lib = RSTR.preset.loadStyleLibrary();
        if (!(name in lib)) {
          RSTR.preset.saveStyleToLibrary(name, style);
          added++;
          continue;
        }
        if (lib[name] && lib[name].id === style.id) {
          unchanged++;
          continue;
        }
        let n = 2;
        let candidate = `${name} (${n})`;
        while (candidate in lib) {
          n++;
          candidate = `${name} (${n})`;
        }
        RSTR.preset.saveStyleToLibrary(candidate, style);
        renamed++;
      }
      ui.buildStyleSelect();
      const parts = [];
      if (added) parts.push(`${added} added`);
      if (renamed) parts.push(`${renamed} renamed (name clash)`);
      if (unchanged) parts.push(`${unchanged} unchanged`);
      if (invalid) parts.push(`${invalid} skipped`);
      ui.showToast(parts.length ? `Import: ${parts.join(', ')}` : 'Nothing to import');
    };
    reader.onerror = () => ui.showToast('Could not read file');
    reader.readAsText(file);
  }

  // ---------- global Ctrl+V: image -> load as source, style text -> apply, else -> toast ----------
  // Reads the `paste` ClipboardEvent's e.clipboardData, NOT navigator.clipboard.read() —
  // the async Clipboard API is commonly permission-blocked on file:// pages (see the
  // fallbackCopyText comment above), while the paste event is user-initiated and needs
  // no permission, so it works over file://.
  ui.isEditableTarget = function isEditableTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
  }

  ui.handleGlobalPaste = function handleGlobalPaste(e) {
    // Inline-input widget, the scrub click-to-type input, the color picker's hex
    // field — all real <input>/<textarea> elements. Let the browser paste normally.
    if (ui.isEditableTarget(e.target)) return;

    const dt = e.clipboardData;
    if (!dt) return;
    e.preventDefault();

    // 1) an image on the clipboard (screenshot, image copied from a browser) —
    // reuse the exact same load path as drag-drop / the file input.
    let imageFile = null;
    if (dt.items) {
      for (const it of dt.items) {
        if (it.kind === 'file' && /^image\//.test(it.type)) {
          imageFile = it.getAsFile();
          break;
        }
      }
    }
    if (!imageFile && dt.files && dt.files.length) {
      imageFile = Array.from(dt.files).find((f) => /^image\//.test(f.type)) || null;
    }
    if (imageFile) {
      ui.loadImageFile(imageFile);
      ui.showToast('Pasted image');
      return;
    }

    // 2) text — a style (rstr_ id or style JSON) via the SAME parse/apply path
    // PASTE CODE uses, or a toast if it isn't one. Never crash on junk text.
    const text = dt.getData ? dt.getData('text/plain') : '';
    if (!text || !text.trim()) return; // nothing on the clipboard we understand
    try {
      const style = RSTR.preset.parseStyleCode(text);
      ui.applyStyle(style);
      ui.showToast(`Loaded ${style.name ? '"' + style.name + '"' : 'style'}`);
    } catch (err) {
      ui.showToast(err.message || 'Clipboard text is not a style');
    }
  }

  // ---------- inline input widget (paste / save-name — no browser dialogs) ----------
  let inlineHandler = null;
  ui.openInline = function openInline(placeholder, initial, handler) {
    ui.els.inlineField.placeholder = placeholder;
    ui.els.inlineField.value = initial || '';
    ui.els.inlineError.textContent = '';
    ui.els.inlineInput.style.display = '';
    inlineHandler = handler;
    ui.els.inlineField.focus();
    ui.els.inlineField.select();
  }
  ui.closeInline = function closeInline() {
    ui.els.inlineInput.style.display = 'none';
    ui.els.inlineError.textContent = '';
    ui.els.inlineField.value = '';
    inlineHandler = null;
    ui.pendingOverwrite = null;
  }
  ui.applyInline = function applyInline() {
    if (!inlineHandler) return;
    const err = inlineHandler(ui.els.inlineField.value);
    if (err) {
      ui.els.inlineError.textContent = err;
      return;
    }
    ui.closeInline();
  }

  ui.resetStyle = function resetStyle() {
    ui.state.mix = [];
    ui.preLayerRef = null; // ui.state.mix is gone, so any committed PREPROCESS layer reference is stale
    ui.state.output = RSTR.preset.defaultOutput();
    ui.state.outputEnabled = true;
    ui.state.pre = RSTR.preset.defaultPre();
    ui.state.source = RSTR.preset.defaultSource();
    ui.goNewMode();
    ui.buildMixList();
    ui.syncPreUI();
    ui.requestOutput();
  }

  // ---------- image loading / reset ----------
  ui.loadImageFile = function loadImageFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const img = new Image();
    img.onload = () => {
      ui.pipeline.setImage(img, img.naturalWidth, img.naturalHeight);
      ui.els.canvas.classList.add('visible');
      ui.els.dropzone.classList.add('hidden');
      ui.els.newImageBtn.classList.add('show');
      ui.els.viewportControls.classList.add('show');
      ui.state.imageName = file.name.replace(/\.[^.]+$/, '') || 'rstr';
      // CANVAS defaults to the source's OWN width on every freshly-loaded
      // image — opens 1:1, no resampling (not a static default — ui.applyStyle()
      // never touches this, so a pasted/loaded style code's own output.scale
      // is left alone). ui.pipeline.rawW is set by ui.pipeline.setImage() above.
      ui.state.output.scale = { mode: 'width', size: ui.pipeline.rawW, width: null, height: null };
      ui.buildPreSection(); // CANVAS's min/max/reset are source-width-dependent — re-range for the new image
      if (ui.state.editTarget.kind === 'output') ui.buildOutputEditor(); // keep an open OUTPUT tab in sync
      ui.view.lastW = 0; // force a re-fit once the new resolution is applied
      ui.view.lastH = 0;
      ui.view.freshImage = true; // new source — refit capped at 100%, not a CANVAS-drag zoom compensation
      ui.requestOutput();
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  }

  ui.clearImage = function clearImage() {
    ui.pipeline.clearImage();
    ui.els.canvas.classList.remove('visible');
    ui.els.dropzone.classList.remove('hidden');
    ui.els.newImageBtn.classList.remove('show');
    ui.els.viewportControls.classList.remove('show');
    ui.refreshOutputVisuals();
  }
})((window.RSTR = window.RSTR || {}));
