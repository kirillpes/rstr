// ui/workbench.js — workbench
(function (RSTR) {
  'use strict';
  const ui = RSTR.ui;

  // ---------- viewport (display only — CSS transform on #canvas-transform) ----------
  // Panning/zooming never re-renders the ui.pipeline; EXPORT and the engine always
  // use the full processing-resolution canvas backing store, independent of zoom.
  // freshImage: true right after a NEW source loads (or at boot) — the next
  // backing-store change should re-FIT (capped at 100%, see refitView), not
  // compensate zoom. Cleared the moment that fit runs; a later backing-store
  // change on the SAME image (e.g. dragging PRE's CANVAS scrub) preserves
  // on-screen size instead — see ui.frame()'s width/height watcher below.
  ui.view = { zoom: 1, panX: 0, panY: 0, fitZoom: 1, lastW: 0, lastH: 0, freshImage: true };

  ui.applyView = function applyView() {
    ui.els.canvasTransform.style.transform = `translate(${ui.view.panX}px, ${ui.view.panY}px) scale(${ui.view.zoom})`;
    const pct = Math.round(ui.view.zoom * 100);
    ui.els.zoomSlider.value = String(Math.max(5, Math.min(400, pct)));
    ui.els.zoomReadout.textContent = pct + '%';
  }

  ui.centerView = function centerView() {
    const vw = ui.els.canvasWrap.clientWidth;
    const vh = ui.els.canvasWrap.clientHeight;
    ui.view.panX = (vw - ui.els.canvas.width * ui.view.zoom) / 2;
    ui.view.panY = (vh - ui.els.canvas.height * ui.view.zoom) / 2;
  }

  // Fit-to-view preserving aspect (contain), capped at 100% — never upscale a
  // small source past its native size (a 256x256 image opens 1:1, not blown
  // up to fill the viewport). Only called for a genuinely NEW image (or the
  // Fit button / a window resize); a CANVAS-driven backing-store resize on
  // the SAME image instead compensates zoom directly — see ui.frame(). Centered.
  ui.refitView = function refitView() {
    const vw = ui.els.canvasWrap.clientWidth;
    const vh = ui.els.canvasWrap.clientHeight;
    const iw = ui.els.canvas.width;
    const ih = ui.els.canvas.height;
    if (!iw || !ih || !vw || !vh) return;
    ui.view.fitZoom = Math.min(1, vw / iw, vh / ih);
    ui.view.zoom = ui.view.fitZoom;
    ui.centerView();
    ui.applyView();
  }

  ui.setZoom100 = function setZoom100() {
    ui.view.zoom = 1;
    ui.centerView();
    ui.applyView();
  }

  // Zoom to `z`, keeping the image point under viewport coords (ax,ay) fixed.
  ui.zoomAt = function zoomAt(z, ax, ay) {
    const nz = Math.max(0.05, Math.min(4, z));
    const imgX = (ax - ui.view.panX) / ui.view.zoom;
    const imgY = (ay - ui.view.panY) / ui.view.zoom;
    ui.view.panX = ax - imgX * nz;
    ui.view.panY = ay - imgY * nz;
    ui.view.zoom = nz;
    ui.applyView();
  }

  ui.wireViewport = function wireViewport() {
    ui.els.zoomSlider.addEventListener('input', () => {
      const vw = ui.els.canvasWrap.clientWidth;
      const vh = ui.els.canvasWrap.clientHeight;
      ui.zoomAt(Number(ui.els.zoomSlider.value) / 100, vw / 2, vh / 2);
    });
    ui.els.zoomFit.addEventListener('click', ui.refitView);
    ui.els.zoom100.addEventListener('click', ui.setZoom100);

    // Ctrl + wheel zooms toward the cursor; plain wheel does nothing.
    ui.els.canvasWrap.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const rect = ui.els.canvasWrap.getBoundingClientRect();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        ui.zoomAt(ui.view.zoom * factor, e.clientX - rect.left, e.clientY - rect.top);
      },
      { passive: false }
    );

    // Middle-mouse drag pans.
    let panning = false;
    let panStart = null;
    ui.els.canvasWrap.addEventListener('mousedown', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      panning = true;
      panStart = { x: e.clientX, y: e.clientY, panX: ui.view.panX, panY: ui.view.panY };
    });
    ui.els.canvasWrap.addEventListener('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!panning) return;
      ui.view.panX = panStart.panX + (e.clientX - panStart.x);
      ui.view.panY = panStart.panY + (e.clientY - panStart.y);
      ui.applyView();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 1) panning = false;
    });

    window.addEventListener('resize', () => {
      if (ui.pipeline && ui.pipeline.hasImage()) ui.refitView();
    });
  }

  // ---------- PRE module (pinned, global preprocessing block) ----------
  // Permanently-attached compact section, sandwiched between the effect list
  // and the settings/edit panel (mirrors tooooools' "Image Preprocessing").
  // Always expanded — no collapse toggle. Built ONCE (boot); every change
  // afterwards mutates ui.state.pre + calls ui.syncPreUI() to refresh
  // transforms/labels/positions in place — never a DOM rebuild, so an
  // in-flight pointer-capture drag survives its own event handler re-running.
  // On top of that, every change reconciles a single committed PREPROCESS
  // mix layer (reconcilePreLayer, below) — PRE is edited live through this
  // module, but it's a normal, independent stack layer, not a special case.
  ui.preEls = {}; // populated once by ui.buildPreSection()
  const PRE_SCRUB_KEYS = ['blur', 'grain', 'gamma'];

  // The single committed 'preprocess' layer object living in ui.state.mix (at
  // the FRONT — applied first, global preprocessing), or null when PRE is at
  // identity and nothing is committed. Tracked BY REFERENCE so a LAYERS drag
  // reordering it, or any other code holding onto the same object, still
  // resolves correctly via ui.state.mix.indexOf(ui.preLayerRef) below.
  // preLayerRef lives on ui — initialized in core.js

  // Keeps editTarget's [n] pointing at the same logical layer across
  // ui.reconcilePreLayer()'s own insert/remove of the PREPROCESS layer — same
  // index bookkeeping ui.removeLayer() already does for a manual removal, so
  // EDIT never silently re-targets onto the wrong layer.
  ui.adjustEditIndexForInsertAtFront = function adjustEditIndexForInsertAtFront() {
    if (ui.state.editTarget.kind === 'layer') {
      ui.state.editTarget.index += 1;
      ui.refreshTargetHeader(); // keep the displayed "EDIT · X [n]" in sync
    }
  }
  ui.adjustEditIndexForRemoval = function adjustEditIndexForRemoval(removedIndex) {
    if (ui.state.editTarget.kind !== 'layer') return;
    if (ui.state.editTarget.index === removedIndex) {
      // Was directly EDITing the just-removed PREPROCESS layer itself (e.g.
      // clicked its own row in the mix list) — redirect to a safe target.
      // 'preprocess' is internal (not in the NEW-mode picker), so unlike
      // ui.removeLayer()'s ui.selectEffect(removed.effect) fallback there's no
      // sensible NEW-mode target to fall back to; OUTPUT always exists.
      ui.state.editTarget = { kind: 'output' };
      ui.buildEditor();
    } else if (ui.state.editTarget.index > removedIndex) {
      ui.state.editTarget.index -= 1;
      ui.buildEditor(); // refresh the [n] index in the header — same as ui.removeLayer()
    }
  }

  // Reconciles ui.state.mix's committed PREPROCESS layer with the live PRE
  // working buffer (ui.state.pre) — called on every PRE change (onPreChange).
  // Non-identity => exactly one 'preprocess' layer at the FRONT of the stack
  // (applied first); back to identity => that layer is removed. No
  // fragmentation (unlike the old "glued under the next ADDed effect" bake)
  // and no reset — PRE is now a normal, independently-edited layer that just
  // happens to have a dedicated always-visible editor (this module) instead
  // of living behind EDIT/NEW.
  ui.reconcilePreLayer = function reconcilePreLayer() {
    const identity = RSTR.preset.preIsIdentity(ui.state.pre);
    if (identity) {
      if (ui.preLayerRef) {
        const i = ui.state.mix.indexOf(ui.preLayerRef);
        if (i >= 0) {
          ui.state.mix.splice(i, 1);
          ui.adjustEditIndexForRemoval(i);
        }
        ui.preLayerRef = null;
        ui.buildMixList();
      }
      return;
    }
    if (!ui.preLayerRef) {
      ui.preLayerRef = { effect: 'preprocess', enabled: true, params: {} };
      ui.state.mix.unshift(ui.preLayerRef); // FRONT = applied first, mirrors applyStyle's legacy-`pre` unshift
      ui.adjustEditIndexForInsertAtFront();
      ui.buildMixList();
    }
    ui.preLayerRef.params = { ...ui.state.pre }; // keep the committed layer's values in sync
  }

  ui.formatPreValue = function formatPreValue(key, v) {
    if (key === 'blur' || key === 'blackPoint' || key === 'whitePoint') return String(Math.round(v));
    return Number(v).toFixed(1); // grain, gamma
  }

  // PRE "Canvas" writes straight through to OUTPUT's scale block (single
  // source of truth — geometry stays crop→scale→effects, WYSIWYG, style-code
  // compatible): explicit WORKING-BUFFER WIDTH in px (mode 'width'). Every
  // ported effect param (stipple min/maxWidth, dots spacing, crt pitch, …) is
  // tuned in absolute px against this buffer size — see CLAUDE.md "WHY".
  ui.preCanvasSize = function preCanvasSize() {
    const s = ui.state.output.scale;
    if (s.mode === 'width' && s.size) return s.size;
    // Any other mode (none/fit/exact, e.g. from a loaded style code): show the
    // CURRENT effective width so the scrub isn't blank; dragging it takes over
    // as 'width' mode (same takeover behavior the old Scale % scrub had).
    if (ui.pipeline && ui.pipeline.hasImage()) {
      const geo = RSTR.computeGeometry(ui.pipeline.rawW, ui.pipeline.rawH, ui.effectiveOutput());
      return geo.tw;
    }
    return 1000;
  }
  // CANVAS's travel is source-dependent: max = 2x the loaded image's raw
  // width (rounded to the nearest 100), so the native-size default sits at
  // the midpoint and the user can still push to ~200%. min stays fixed at
  // 100. No image loaded yet (boot) -> fall back to the old static 2000.
  ui.preCanvasMax = function preCanvasMax() {
    if (ui.pipeline && ui.pipeline.hasImage() && ui.pipeline.rawW) {
      return Math.max(200, Math.round((2 * ui.pipeline.rawW) / 100) * 100);
    }
    return 2000;
  }
  ui.setPreCanvasSize = function setPreCanvasSize(px) {
    if (!ui.pipeline || !ui.pipeline.hasImage()) return;
    const size = Math.max(100, Math.min(ui.preCanvasMax(), Math.round(px)));
    ui.state.output.scale = { mode: 'width', size, width: null, height: null };
    if (ui.state.editTarget.kind === 'output') ui.buildOutputEditor(); // keep the open OUTPUT tab in sync
    ui.requestOutput();
  }
  // Single source of truth for CANVAS's reset target: the loaded source's
  // native width (same value a fresh image load sets) — used both as the
  // scrub's own dblclick-reset value and by PRE's RESET button.
  ui.preCanvasResetValue = function preCanvasResetValue() {
    return ui.pipeline && ui.pipeline.hasImage() && ui.pipeline.rawW ? ui.pipeline.rawW : 1000;
  }
  ui.formatCanvasSize = function formatCanvasSize(px) {
    return Math.round(px) + 'px';
  }

  ui.onPreChange = function onPreChange() {
    ui.requestRender();
    ui.syncPreUI();
    ui.reconcilePreLayer(); // keep the committed PREPROCESS mix layer in sync — see ui.reconcilePreLayer()
  }

  // Refresh every PRE visual (dot, knob ticks/labels, handle positions,
  // readout, collapsed ui.state) from current state — no DOM (re)creation.
  ui.syncPreUI = function syncPreUI() {
    if (!ui.preEls.section) return; // not built yet
    const pre = ui.state.pre;
    ui.preEls.dot.classList.toggle('active', !RSTR.preset.preIsIdentity(pre));

    for (const s of ui.preEls.scrubs) s.sync();

    const bp = pre.blackPoint != null ? pre.blackPoint : 0;
    const wp = pre.whitePoint != null ? pre.whitePoint : 255;
    ui.preEls.handleBP.style.left = (bp / 255) * 100 + '%';
    ui.preEls.handleWP.style.left = (wp / 255) * 100 + '%';
    ui.preEls.levelsReadout.textContent = `BP ${Math.round(bp)} · WP ${Math.round(wp)}`;
  }

  // Horizontal pointer-capture drag along the track (0..255, unclamped
  // against the other handle — bp may cross wp, matching tooooools) +
  // dblclick (reset to 0 or 255).
  ui.wireHandle = function wireHandle(handle, track, key, resetValue) {
    let dragId = null;
    handle.addEventListener('pointerdown', (e) => {
      handle.setPointerCapture(e.pointerId);
      dragId = e.pointerId;
      e.stopPropagation();
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (dragId !== e.pointerId) return;
      const rect = track.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      ui.state.pre[key] = Math.round(t * 255);
      ui.onPreChange();
    });
    const release = (e) => {
      if (dragId === e.pointerId) dragId = null;
    };
    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);
    handle.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      ui.state.pre[key] = resetValue;
      ui.onPreChange();
    });
  }

  // Built at boot, and rebuilt on every fresh image load (CANVAS's range is
  // source-width-dependent — see preCanvasMax). `#pre-section` is an empty
  // container in index.html — everything inside it is generated here, same
  // convention as #effect-list / #mix-list / #align-picker.
  ui.buildPreSection = function buildPreSection() {
    const section = ui.els.preSection;
    section.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'pre-header';
    const title = document.createElement('span');
    title.className = 'pre-title';
    title.textContent = 'Preprocess'; // rendered uppercase by the global CSS text-transform, matches the committed layer's own display name (effects.js 'preprocess'.name)
    const dot = document.createElement('span');
    dot.className = 'pre-dot';
    dot.textContent = '●';
    const spacer = document.createElement('span');
    spacer.className = 'pre-spacer';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'pre-mini-btn';
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      ui.state.pre = RSTR.preset.defaultPre();
      ui.setPreCanvasSize(ui.preCanvasResetValue()); // CANVAS isn't part of ui.state.pre — reset it via its own path
      ui.onPreChange();
    });
    header.append(title, dot, spacer, resetBtn);

    const body = document.createElement('div');
    body.className = 'pre-body';

    const scrubCol = document.createElement('div');
    scrubCol.className = 'pre-scrubs';
    const scrubs = [];
    // Canvas first — the working-buffer WIDTH in px (see preCanvasSize / CLAUDE.md "WHY").
    // min/max/reset are source-dependent (preCanvasMax / the loaded image's raw
    // width) — that's why ui.buildPreSection() is re-run on every fresh image load,
    // not just once at boot.
    scrubs.push(
      scrubCol.appendChild(
        ui.makeScrub({
          label: 'Canvas',
          min: 100,
          max: ui.preCanvasMax(),
          step: 1, // per-pixel granularity — every value is reachable; `snap` below only magnetizes
          snap: 100, // drag is smooth (1px) but sticks near hundreds — see SCRUB_MAGNET_TOLERANCE
          get: ui.preCanvasSize,
          set: ui.setPreCanvasSize,
          format: ui.formatCanvasSize,
          reset: ui.preCanvasResetValue(),
        })
      )
    );
    const scrubDefs = RSTR.getEffect('preprocess').params.filter((p) => PRE_SCRUB_KEYS.indexOf(p.key) >= 0);
    for (const param of scrubDefs) {
      scrubs.push(
        scrubCol.appendChild(
          ui.makeScrub({
            label: param.label,
            min: param.min,
            max: param.max,
            step: param.step,
            get: () => (ui.state.pre[param.key] != null ? ui.state.pre[param.key] : param.default),
            set: (v) => {
              ui.state.pre[param.key] = v;
              ui.onPreChange();
            },
            format: (v) => ui.formatPreValue(param.key, v),
            reset: param.default,
          })
        )
      );
    }

    const levelsRow = document.createElement('div');
    levelsRow.className = 'pre-levels-row';
    const track = document.createElement('div');
    track.className = 'pre-track';
    for (let i = 0; i < 16; i++) {
      const block = document.createElement('div');
      block.className = 'pre-track-block';
      const v = Math.round((i * 255) / 15);
      block.style.background = `rgb(${v},${v},${v})`;
      track.appendChild(block);
    }
    const handleBP = document.createElement('div');
    handleBP.className = 'pre-handle pre-handle-bp';
    handleBP.title = 'Black point';
    const handleWP = document.createElement('div');
    handleWP.className = 'pre-handle pre-handle-wp';
    handleWP.title = 'White point';
    track.append(handleBP, handleWP);
    ui.wireHandle(handleBP, track, 'blackPoint', 0);
    ui.wireHandle(handleWP, track, 'whitePoint', 255);

    const readout = document.createElement('div');
    readout.className = 'pre-levels-readout';

    levelsRow.append(track, readout);
    body.append(scrubCol, levelsRow);
    section.append(header, body);

    ui.preEls.section = section;
    ui.preEls.dot = dot;
    ui.preEls.body = body;
    ui.preEls.scrubs = scrubs;
    ui.preEls.track = track;
    ui.preEls.handleBP = handleBP;
    ui.preEls.handleWP = handleWP;
    ui.preEls.levelsReadout = readout;

    ui.syncPreUI();
  }

  // ---------- OUTPUT editor ----------
  // OUTPUT lists 'width' too: PRE's CANVAS scrub writes that mode, and OUTPUT
  // reads the same ui.state.output.scale — hiding the mode here made the tab show
  // "None (source)" while the image was actually being resized, and touching
  // the select would have silently wiped the canvas size.
  const OUTPUT_SCALE_MODES = ['none', 'fit', 'width', 'exact'];
  const SCALE_MODE_LABELS = {
    none: 'None (source)',
    fit: 'Longest side',
    width: 'Canvas width',
    exact: 'Exact W×H',
  };

  ui.fillSelect = function fillSelect(select, values, current, labels) {
    select.innerHTML = '';
    for (const v of values) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = labels ? labels[v] || v : v;
      if (v === current) o.selected = true;
      select.appendChild(o);
    }
  }

  ui.ratioIsCustom = function ratioIsCustom() {
    const r = ui.state.output.crop.ratio;
    return r !== 'original' && RSTR.preset.RATIOS.indexOf(r) < 0;
  }

  ui.buildOutputEditor = function buildOutputEditor() {
    const custom = ui.ratioIsCustom();
    ui.fillSelect(ui.els.ratioSelect, RSTR.preset.RATIOS.concat(['custom']), custom ? 'custom' : ui.state.output.crop.ratio);
    if (custom) {
      const parts = ui.state.output.crop.ratio.split(':');
      ui.els.cropW.value = parts[0];
      ui.els.cropH.value = parts[1];
    }
    ui.fillSelect(ui.els.scaleModeSelect, OUTPUT_SCALE_MODES, ui.state.output.scale.mode, SCALE_MODE_LABELS);
    ui.els.scaleSize.value = ui.state.output.scale.size == null ? '' : String(ui.state.output.scale.size);
    ui.els.scaleW.value = ui.state.output.scale.width == null ? '' : String(ui.state.output.scale.width);
    ui.els.scaleH.value = ui.state.output.scale.height == null ? '' : String(ui.state.output.scale.height);
    ui.fillSelect(ui.els.formatSelect, RSTR.preset.FORMATS, ui.state.output.format);
    ui.els.qualityInput.value = String(ui.state.output.quality);
    ui.els.qualityValue.textContent = ui.state.output.quality.toFixed(2);
    ui.buildAlignPicker();
    ui.syncOutputUI();
  }

  ui.buildAlignPicker = function buildAlignPicker() {
    ui.els.alignPicker.innerHTML = '';
    for (const code of RSTR.preset.ALIGN_CODES) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'align-cell' + (code === ui.state.output.crop.align ? ' active' : '');
      cell.dataset.align = code;
      cell.title = code;
      cell.addEventListener('click', () => {
        ui.state.output.crop.align = code;
        ui.buildAlignPicker();
        ui.requestOutput();
      });
      ui.els.alignPicker.appendChild(cell);
    }
  }

  ui.syncOutputUI = function syncOutputUI() {
    ui.els.cropCustomRow.style.display = ui.ratioIsCustom() ? '' : 'none';
    const m = ui.state.output.scale.mode;
    ui.els.scaleSizeRow.style.display = m === 'fit' || m === 'width' ? '' : 'none';
    ui.els.scaleExactRow.style.display = ui.state.output.scale.mode === 'exact' ? '' : 'none';
    ui.els.qualityRow.style.display = ui.state.output.format !== 'png' ? '' : 'none';
    ui.refreshOutputVisuals();
  }

  // Canvas crop guide + anchor marker + dims readout — reflect the EFFECTIVE
  // output (passthrough when the OUTPUT layer is disabled).
  ui.refreshOutputVisuals = function refreshOutputVisuals() {
    const eff = RSTR.preset.normalizeOutput(ui.effectiveOutput());
    const cropping = eff.crop.ratio !== 'original';
    ui.els.cropGuide.classList.toggle('show', cropping);
    const a = eff.crop.align;
    const left = a.indexOf('L') >= 0 ? 16.667 : a.indexOf('R') >= 0 ? 83.333 : 50;
    const top = a.indexOf('T') >= 0 ? 16.667 : a.indexOf('B') >= 0 ? 83.333 : 50;
    ui.els.cropGuideAnchor.style.left = left + '%';
    ui.els.cropGuideAnchor.style.top = top + '%';
    ui.updateDimsReadout(eff);
    ui.syncPreUI(); // PRE's Scale scrub mirrors output.scale — repaint on any output change
  }

  ui.updateDimsReadout = function updateDimsReadout(eff) {
    if (!ui.pipeline || !ui.pipeline.hasImage()) {
      ui.els.dimsReadout.textContent = 'SRC — × — → OUT — × —';
      return;
    }
    const sw = ui.pipeline.rawW;
    const sh = ui.pipeline.rawH;
    const geo = RSTR.computeGeometry(sw, sh, eff || ui.effectiveOutput());
    ui.els.dimsReadout.textContent = `SRC ${sw}×${sh} → OUT ${geo.tw}×${geo.th}`;
  }

  ui.customRatioFromInputs = function customRatioFromInputs() {
    const w = Number(ui.els.cropW.value);
    const h = Number(ui.els.cropH.value);
    return w > 0 && h > 0 ? `${w}:${h}` : null;
  }

  ui.wireOutputTab = function wireOutputTab() {
    ui.els.ratioSelect.addEventListener('change', () => {
      if (ui.els.ratioSelect.value === 'custom') {
        ui.state.output.crop.ratio = ui.customRatioFromInputs() || '1:1';
        if (!ui.customRatioFromInputs()) {
          ui.els.cropW.value = '1';
          ui.els.cropH.value = '1';
        }
      } else {
        ui.state.output.crop.ratio = ui.els.ratioSelect.value;
      }
      ui.syncOutputUI();
      ui.requestOutput();
    });
    const onCustom = () => {
      const r = ui.customRatioFromInputs();
      if (r) {
        ui.state.output.crop.ratio = r;
        ui.requestOutput();
      }
    };
    ui.els.cropW.addEventListener('input', onCustom);
    ui.els.cropH.addEventListener('input', onCustom);

    ui.els.scaleModeSelect.addEventListener('change', () => {
      ui.state.output.scale.mode = ui.els.scaleModeSelect.value;
      ui.syncOutputUI();
      ui.requestOutput();
    });
    const num = (v) => (v.trim() === '' ? null : Math.max(1, Math.round(Number(v) || 0)) || null);
    ui.els.scaleSize.addEventListener('input', () => {
      ui.state.output.scale.size = num(ui.els.scaleSize.value);
      ui.requestOutput();
    });
    ui.els.scaleW.addEventListener('input', () => {
      ui.state.output.scale.width = num(ui.els.scaleW.value);
      ui.requestOutput();
    });
    ui.els.scaleH.addEventListener('input', () => {
      ui.state.output.scale.height = num(ui.els.scaleH.value);
      ui.requestOutput();
    });

    ui.els.formatSelect.addEventListener('change', () => {
      ui.state.output.format = ui.els.formatSelect.value;
      ui.syncOutputUI();
      ui.requestRender(); // format only affects encode, not the buffer
    });
    ui.els.qualityInput.addEventListener('input', () => {
      ui.state.output.quality = Number(ui.els.qualityInput.value);
      ui.els.qualityValue.textContent = ui.state.output.quality.toFixed(2);
      // quality only affects export encode, never the live buffer, so this
      // handler (uniquely among OUTPUT's fields) never calls requestRender/
      // requestOutput — hook history directly so a quality-only change is
      // still undoable.
      ui.scheduleHistorySync();
    });
  }
})((window.RSTR = window.RSTR || {}));
