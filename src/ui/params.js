// ui/params.js — params
(function (RSTR) {
  'use strict';
  const ui = RSTR.ui;

  // ---------- built-in per-effect presets (array or legacy object) ----------
  ui.builtinPresets = function builtinPresets(def) {
    const p = def.presets;
    if (!p) return [];
    if (Array.isArray(p)) return p.map((x) => ({ name: x.name, params: x.params }));
    return Object.keys(p).map((name) => ({ name, params: p[name] }));
  }

  // ---------- edit panel ----------
  ui.buildEditor = function buildEditor() {
    ui.closeColorPicker(); // the previous target's swatch anchors are about to be torn down
    ui.closePresetsModal(); // switching targets while the modal is open would show stale presets
    const t = ui.state.editTarget;
    if (t.kind === 'output') {
      ui.els.targetHeader.textContent = 'EDIT · OUTPUT';
      ui.els.effectEditor.style.display = 'none';
      ui.els.outputEditor.style.display = 'block';
      // footer stays visible (EXPORT always applies) — only the per-effect
      // Presets/Reset/ADD (none meaningful for OUTPUT) hide.
      ui.els.presetsBtn.style.display = 'none';
      ui.els.settingsResetBtn.style.display = 'none';
      ui.els.addBtn.style.display = 'none';
      ui.buildOutputEditor();
      return;
    }
    const effectId = ui.currentEffectId();
    const def = RSTR.getEffect(effectId);
    ui.els.targetHeader.textContent = t.kind === 'new' ? `NEW · ${def.name}` : `EDIT · ${def.name} [${t.index + 1}]`;
    ui.els.effectEditor.style.display = 'block';
    ui.els.outputEditor.style.display = 'none';
    ui.els.presetsBtn.style.display = '';
    ui.els.settingsResetBtn.style.display = '';
    ui.els.addBtn.style.display = t.kind === 'new' ? '' : 'none';
    ui.buildActiveParams();
  }

  // Restores every param of the CURRENT effect target (NEW or EDIT) to the
  // registry defaults, live-renders, and (in EDIT mode) writes through to the
  // layer via setCurrentParams. Never touches the layer's opacity or its
  // position in the stack — same affordance PRE's own RESET has.
  ui.resetCurrentEffectParams = function resetCurrentEffectParams() {
    const t = ui.state.editTarget;
    if (t.kind === 'output') return;
    const id = ui.currentEffectId();
    ui.setCurrentParams(RSTR.defaultParams(id));
    ui.buildActiveParams();
    ui.requestRender();
  }

  // showIf: { key, in: [...] } — a param is visible only when the CURRENT
  // value of params[showIf.key] (falling back to that param's own default
  // when absent, same fallback the pipeline/renderParamControl use) is one
  // of showIf.in. UI-only: src/pipeline.js keeps uploading every param as a
  // uniform regardless of mode, so a hidden param's value is still live —
  // it's just not exposed to edit while its controller param doesn't select it.
  ui.paramVisible = function paramVisible(param, params, def) {
    if (!param.showIf) return true;
    const controller = def.params.find((p) => p.key === param.showIf.key);
    const val = params[param.showIf.key] != null ? params[param.showIf.key] : controller && controller.default;
    return param.showIf.in.indexOf(val) >= 0;
  }

  ui.buildActiveParams = function buildActiveParams() {
    ui.closeColorPicker(); // rebuild is about to replace/remove any open swatch anchor
    const def = RSTR.getEffect(ui.currentEffectId());
    const container = ui.els.activeParams;
    container.innerHTML = '';
    // Opacity is layer-level, not an effect param — it lives on the layer's
    // row in the MIX stack (see buildMixList), not here.
    const params = ui.currentParams();
    for (const param of def.params) {
      if (!ui.paramVisible(param, params, def)) continue;
      container.appendChild(ui.renderParamControl(param, params));
    }
    if (def.id === 'ascii') container.appendChild(ui.buildAsciiCopyButton());
    if (def.id === 'gradientmap') container.appendChild(ui.buildReverseColorsButton());
  }

  // ---------- ASCII: copy the last-rendered text grid ----------
  ui.buildAsciiCopyButton = function buildAsciiCopyButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ascii-copy-btn';
    btn.textContent = 'COPY TEXT';
    btn.addEventListener('click', () => ui.copyAsciiText(btn));
    return btn;
  }

  // ---------- REVERSE COLORS (gradientmap only) ----------
  // Rewrites existing param VALUES in place — not a new serialized param.
  // gradientmap's `stops` is a {pos,color}[] array: mirroring pos -> 1-pos
  // reverses which color sits at which luminance. (Pre-2026-07-13 this also
  // handled `recolor`'s 3 independently-keyed stop1/pos1..stop3/pos3 — that
  // branch is gone now that recolor is folded into gradientmap's `stops`
  // array; see src/effects.js / src/preset.js LEGACY_EFFECTS.)
  ui.buildReverseColorsButton = function buildReverseColorsButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reverse-colors-btn';
    btn.textContent = 'REVERSE';
    btn.title = 'Reverse the color mapping';
    btn.addEventListener('click', () => ui.reverseColors());
    return btn;
  }

  ui.reverseColors = function reverseColors() {
    const def = RSTR.getEffect(ui.currentEffectId());
    if (def.id !== 'gradientmap') return;
    const params = ui.currentParams();
    const stopsParam = def.params.find((p) => p.key === 'stops');
    const stops = ui.ensureStopsArray(stopsParam, params);
    for (const s of stops) s.pos = 1 - s.pos;
    ui.buildActiveParams();
    ui.requestRender();
  }

  ui.copyAsciiText = function copyAsciiText(btn) {
    const text = RSTR.asciiText;
    if (!text) return; // no ascii render yet — nothing to copy
    const onCopied = () => {
      btn.textContent = 'COPIED';
      setTimeout(() => {
        btn.textContent = 'COPY TEXT';
      }, 1000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onCopied, () => ui.fallbackCopyText(text, onCopied));
    } else {
      ui.fallbackCopyText(text, onCopied);
    }
  }

  // file:// pages can lack a working async Clipboard API — fall back to the
  // classic hidden-textarea + execCommand('copy') trick.
  ui.fallbackCopyText = function fallbackCopyText(text, onCopied) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      if (document.execCommand('copy')) onCopied();
    } catch {
      /* non-fatal — user can still select the button's text manually */
    }
    document.body.removeChild(ta);
  }

  ui.renderParamControl = function renderParamControl(param, params) {
    // Gradient stops: a variable-length array value, never a single scalar —
    // built as its own block (not the label+single-control `.param-row`
    // pattern below) because it hosts several interactive children (canvas,
    // flag markers, swatch button, delete button). Wrapping that in a
    // <label> risks the browser's implicit "click label -> activate first
    // labelable descendant" forwarding firing on the WRONG child.
    if (param.type === 'stops') return ui.buildStopsControl(param, params);

    if (param.type === 'range') {
      const step = param.step != null ? param.step : 1;
      const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
      return ui.makeScrub({
        label: param.label,
        min: param.min,
        max: param.max,
        step,
        get: () => (params[param.key] != null ? params[param.key] : param.default),
        set: (v) => {
          params[param.key] = v;
          ui.afterParamEdit(); // auto-commits a NEW-mode target into a layer, see ui.commitNewOnEdit()
        },
        format: (v) => Number(v).toFixed(decimals),
        reset: param.default,
      });
    }

    const row = document.createElement('label');
    row.className = 'param-row';

    const labelText = document.createElement('span');
    labelText.className = 'param-label';
    labelText.textContent = param.label;
    row.appendChild(labelText);

    const current = params[param.key] != null ? params[param.key] : param.default;

    if (param.type === 'color') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch-btn';
      const box = document.createElement('span');
      box.className = 'color-swatch-box';
      box.style.background = current;
      const label = document.createElement('span');
      label.className = 'color-swatch-label';
      label.textContent = current;
      btn.append(box, label);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const value = params[param.key] != null ? params[param.key] : param.default;
        RSTR.ui.openColorPicker(btn, value, (hex) => {
          params[param.key] = hex;
          box.style.background = hex;
          label.textContent = hex;
          ui.afterParamEdit(); // auto-commits a NEW-mode target into a layer, see ui.commitNewOnEdit()
        });
      });
      row.appendChild(btn);
    } else if (param.type === 'select') {
      const select = document.createElement('select');
      for (const opt of param.options) {
        const o = document.createElement('option');
        o.value = String(opt.value);
        o.textContent = opt.label;
        if (String(opt.value) === String(current)) o.selected = true;
        select.appendChild(o);
      }
      select.addEventListener('change', () => {
        params[param.key] = Number(select.value);
        // Commit BEFORE the showIf rebuild below, so if it runs it rebuilds
        // the panel in the now-committed layer context (ui.currentEffectId()/
        // ui.currentParams() already resolve through ui.state.mix, not the stale
        // NEW target) — see ui.commitNewOnEdit(). Not mid-drag (a discrete
        // 'change' event), so the rebuild itself is safe here.
        ui.commitNewOnEdit();
        // If other params show/hide based on THIS select (e.g. dots' `mode`),
        // rebuild the panel so the visible param set updates immediately.
        const def = RSTR.getEffect(ui.currentEffectId());
        if (def.params.some((p) => p.showIf && p.showIf.key === param.key)) {
          ui.buildActiveParams();
        }
        ui.requestRender();
      });
      row.appendChild(select);
    } else if (param.type === 'text') {
      // Free-text param (e.g. ascii's character set) — reaches cpu stages only,
      // never becomes a uniform, so the value must stay a string (no Number()).
      const input = document.createElement('input');
      input.type = 'text';
      input.spellcheck = false;
      input.value = current;
      input.style.flex = '1';
      input.style.minWidth = '0';
      input.addEventListener('input', () => {
        params[param.key] = input.value;
        ui.afterParamEdit(); // auto-commits a NEW-mode target into a layer, see ui.commitNewOnEdit()
      });
      row.appendChild(input);
    }
    return row;
  }

  // ---------- gradient stops (Figma-style) — gradientmap's `stops` param ----------
  // Defensive repair: params[key] should already be a valid >=2-entry stops
  // array by the time a settings panel is built (RSTR.defaultParams clones the
  // registry default; applySelectedPreset/validatePreset sanitize presets and
  // pasted style codes) — this is a last-resort guard against any path that
  // slips through, not the primary sanitizer.
  ui.ensureStopsArray = function ensureStopsArray(param, params) {
    const raw = params[param.key];
    const valid =
      Array.isArray(raw) &&
      raw.length >= 2 &&
      raw.every((s) => s && typeof s.pos === 'number' && typeof s.color === 'string');
    if (!valid) params[param.key] = JSON.parse(JSON.stringify(param.default));
    return params[param.key];
  }

  ui.buildStopsControl = function buildStopsControl(param, params) {
    ui.ensureStopsArray(param, params);
    const getStops = () => params[param.key];
    const gmDef = RSTR.getEffect('gradientmap');

    const wrap = document.createElement('div');
    wrap.className = 'param-row-stops';

    const labelRow = document.createElement('div');
    labelRow.className = 'stops-label-row';
    const labelText = document.createElement('span');
    labelText.className = 'param-label';
    labelText.textContent = param.label;
    labelRow.appendChild(labelText);
    wrap.appendChild(labelRow);

    // Gradient bar: painted from the LUT (RSTR.getEffect('gradientmap').buildLut) —
    // same interpolation the cpu() render stage uses, so the preview never drifts
    // from the actual output. Fixed 256px internal resolution == the LUT's own
    // resolution (CSS stretches it to the panel's full width; content may be
    // colorful, the chrome around it stays grayscale/1px/square).
    const barWrap = document.createElement('div');
    barWrap.className = 'stops-bar-wrap';
    const bar = document.createElement('canvas');
    bar.className = 'stops-bar';
    bar.width = 256;
    bar.height = 24;
    barWrap.appendChild(bar);
    const track = document.createElement('div');
    track.className = 'stops-flags-track';
    barWrap.appendChild(track);
    wrap.appendChild(barWrap);

    const selRow = document.createElement('div');
    selRow.className = 'stops-selected-row';
    const swatchBtn = document.createElement('button');
    swatchBtn.type = 'button';
    swatchBtn.className = 'color-swatch-btn';
    const swatchBox = document.createElement('span');
    swatchBox.className = 'color-swatch-box';
    const swatchLabel = document.createElement('span');
    swatchLabel.className = 'color-swatch-label';
    swatchBtn.append(swatchBox, swatchLabel);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'stops-del-btn';
    delBtn.textContent = 'DEL STOP';
    selRow.append(swatchBtn, delBtn);
    wrap.appendChild(selRow);

    let selectedIndex = 0;
    const ctx = bar.getContext('2d');

    function paintBar() {
      const lut = gmDef.buildLut(getStops());
      const img = ctx.createImageData(bar.width, bar.height);
      for (let x = 0; x < bar.width; x++) {
        const r = lut[x * 3];
        const g = lut[x * 3 + 1];
        const b = lut[x * 3 + 2];
        for (let y = 0; y < bar.height; y++) {
          const o = (y * bar.width + x) * 4;
          img.data[o] = r;
          img.data[o + 1] = g;
          img.data[o + 2] = b;
          img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    // Cheap in-place visual update (no DOM rebuild) — selection changes during
    // a drag must never rebuild `track`, or the flag under active pointer
    // capture would be disconnected and the drag would silently die.
    function updateSelectedClasses() {
      Array.from(track.children).forEach((el, i) => el.classList.toggle('selected', i === selectedIndex));
    }

    function refreshSelectedRow() {
      const stops = getStops();
      const s = stops[selectedIndex] || stops[0];
      swatchBox.style.background = s.color;
      swatchLabel.textContent = s.color;
      delBtn.disabled = stops.length <= 2;
    }

    function selectStop(i) {
      selectedIndex = i;
      updateSelectedClasses();
      refreshSelectedRow();
    }

    // Minimum 2 stops — no-op (button disabled / Delete key silently ignored)
    // when only 2 remain.
    function removeStop(i) {
      const stops = getStops();
      if (stops.length <= 2) return;
      stops.splice(i, 1);
      selectedIndex = Math.max(0, Math.min(selectedIndex, stops.length - 1));
      paintBar();
      paintFlags();
      refreshSelectedRow();
      ui.commitNewOnEdit(); // auto-commits a NEW-mode target into a layer, see ui.commitNewOnEdit()
      ui.requestRender();
    }

    // Horizontal pointer-capture drag along the bar (same pattern as the PRE
    // module's black/white-point handles, ui.wireHandle() above) — stops MAY
    // cross each other; evaluation (buildLut) always sorts a COPY, so crossing
    // is never forbidden or resolved here, only clamped to 0..1.
    function wireFlag(flag, i) {
      let dragId = null;
      flag.addEventListener('pointerdown', (e) => {
        flag.setPointerCapture(e.pointerId);
        dragId = e.pointerId;
        selectStop(i);
        e.preventDefault();
        e.stopPropagation();
      });
      flag.addEventListener('pointermove', (e) => {
        if (dragId !== e.pointerId) return;
        const rect = bar.getBoundingClientRect();
        const t = rect.width > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
        const pos = Math.round(t * 1000) / 1000;
        getStops()[i].pos = pos;
        flag.style.left = pos * 100 + '%'; // in-place — no track rebuild mid-drag
        paintBar();
        ui.commitNewOnEdit(); // auto-commits a NEW-mode target into a layer, see ui.commitNewOnEdit()
        ui.requestRender();
      });
      const release = (e) => {
        if (dragId === e.pointerId) dragId = null;
      };
      flag.addEventListener('pointerup', release);
      flag.addEventListener('pointercancel', release);
      // Delete/Backspace scoped to the flag element itself (focusable via
      // tabIndex) rather than a document-level listener — so there is nothing
      // to leak/unwire when the settings panel later rebuilds and this flag
      // is discarded.
      flag.tabIndex = 0;
      flag.addEventListener('keydown', (e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          removeStop(i);
        }
      });
      flag.addEventListener('dblclick', (e) => {
        // don't let a dblclick on an existing flag fall through to the bar's
        // "add a stop here" handler below.
        e.stopPropagation();
      });
    }

    // Full rebuild of the flag markers — only called for discrete add/remove/
    // init, never mid-drag (see wireFlag's pointermove, which mutates the
    // existing flag's style.left in place instead).
    function paintFlags() {
      track.innerHTML = '';
      getStops().forEach((s, i) => {
        const flag = document.createElement('div');
        flag.className = 'stop-flag' + (i === selectedIndex ? ' selected' : '');
        flag.style.left = s.pos * 100 + '%';
        wireFlag(flag, i);
        track.appendChild(flag);
      });
    }

    // Double-click an empty spot on the bar = add a stop there, seeded with
    // the color the gradient currently shows at that x (an exact LUT sample).
    bar.addEventListener('dblclick', (e) => {
      const rect = bar.getBoundingClientRect();
      const t = rect.width > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
      const lut = gmDef.buildLut(getStops());
      const idx = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
      const hex =
        '#' +
        [lut[idx], lut[idx + 1], lut[idx + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      const stops = getStops();
      stops.push({ pos: Math.round(t * 1000) / 1000, color: hex });
      selectedIndex = stops.length - 1;
      paintFlags();
      refreshSelectedRow();
      ui.commitNewOnEdit(); // auto-commits a NEW-mode target into a layer, see ui.commitNewOnEdit()
      ui.requestRender();
    });

    swatchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = selectedIndex;
      const stops = getStops();
      RSTR.ui.openColorPicker(swatchBtn, stops[idx].color, (hex) => {
        stops[idx].color = hex;
        refreshSelectedRow();
        paintBar();
        ui.commitNewOnEdit(); // auto-commits a NEW-mode target into a layer, see ui.commitNewOnEdit()
        ui.requestRender();
      });
    });

    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeStop(selectedIndex);
    });

    paintBar();
    paintFlags();
    refreshSelectedRow();

    return wrap;
  }

  // ---------- per-effect param-presets — expandable modal ----------
  // Replaces the old cramped footer `#preset-row` (select + Save + Del) with
  // a PRESETS button that opens a brutalist overlay: registry presets + user
  // presets as clickable rows (apply on click), Save (via the shared
  // #inline-input widget) and per-row Del live in the modal. No native
  // alert/confirm/prompt anywhere.
  ui.buildPresetsModalList = function buildPresetsModalList() {
    const def = RSTR.getEffect(ui.currentEffectId());
    ui.els.presetsModalTitle.textContent = 'Presets · ' + def.name;
    const list = ui.els.presetsList;
    list.innerHTML = '';

    const makeRow = (label, onClick) => {
      const row = document.createElement('div');
      row.className = 'presets-row';
      const name = document.createElement('span');
      name.className = 'presets-row-name';
      name.textContent = label;
      row.appendChild(name);
      row.addEventListener('click', onClick);
      return row;
    };

    list.appendChild(makeRow('(default)', () => ui.applyPresetByValue('__default__')));

    for (const p of ui.builtinPresets(def)) {
      list.appendChild(makeRow(p.name, () => ui.applyPresetByValue('b:' + p.name)));
    }

    const user = RSTR.preset.loadEffectPresets(def.id);
    for (const name of Object.keys(user)) {
      const row = makeRow(name + ' *', () => ui.applyPresetByValue('u:' + name));
      const del = ui.iconButton('✕', 'Delete preset', () => {
        RSTR.preset.deleteEffectPreset(def.id, name);
        ui.showToast(`Deleted preset "${name}"`);
        ui.buildPresetsModalList();
      });
      row.appendChild(del);
      list.appendChild(row);
    }
  }

  ui.applyPresetByValue = function applyPresetByValue(val) {
    const def = RSTR.getEffect(ui.currentEffectId());
    let params;
    if (val === '__default__') {
      params = RSTR.defaultParams(def.id);
    } else if (val.slice(0, 2) === 'b:') {
      const found = ui.builtinPresets(def).find((p) => p.name === val.slice(2));
      params = found ? ui.cloneParamsBag(found.params) : RSTR.defaultParams(def.id);
    } else {
      const user = RSTR.preset.loadEffectPresets(def.id);
      params = ui.cloneParamsBag(user[val.slice(2)]);
    }
    ui.setCurrentParams(params);
    ui.buildActiveParams();
    ui.requestRender();
    ui.closePresetsModal();
  }

  ui.openPresetsModal = function openPresetsModal() {
    if (ui.state.editTarget.kind === 'output') return;
    ui.buildPresetsModalList();
    ui.els.presetsBackdrop.style.display = 'block';
    ui.els.presetsModal.style.display = 'flex';
  }

  ui.closePresetsModal = function closePresetsModal() {
    if (!ui.els.presetsBackdrop) return; // not booted yet
    ui.els.presetsBackdrop.style.display = 'none';
    ui.els.presetsModal.style.display = 'none';
  }

  ui.saveCurrentPresetFlow = function saveCurrentPresetFlow() {
    const def = RSTR.getEffect(ui.currentEffectId());
    ui.openInline(`Save "${def.name}" preset as…`, '', (text) => {
      const name = String(text).trim();
      if (!name) return 'Enter a name';
      RSTR.preset.saveEffectPreset(def.id, name, ui.currentParams());
      ui.showToast(`Saved preset "${name}"`);
      ui.buildPresetsModalList();
      return null;
    });
  }

  // Shallow-spreading a params bag ({ ...params }) only copies the top-level
  // keys — an array/object VALUE (e.g. gradientmap's `stops`) stays the same
  // reference. `found.params` below (a builtin preset) is a literal living in
  // the EFFECTS registry, shared forever across the whole session: without a
  // deep clone here, dragging/adding/removing a stop on a layer that applied
  // "Duotone" would mutate the registry's OWN "Duotone" preset, corrupting it
  // for every other layer that ever applies it again.
  ui.cloneParamsBag = function cloneParamsBag(o) {
    const out = {};
    for (const k of Object.keys(o || {})) {
      const v = o[k];
      out[k] = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
    }
    return out;
  }
})((window.RSTR = window.RSTR || {}));
