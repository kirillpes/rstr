// ui/color.js — color
(function (RSTR) {
  'use strict';
  const ui = RSTR.ui;

  // ---------- shared color picker (brutalist HSV popover) ----------
  // A singleton popover, built once and appended directly to #panel (NOT
  // inside #active-params), so a settings-panel rebuild never orphans it —
  // it lives outside the container that gets torn down. ui.buildEditor() /
  // ui.buildActiveParams() close it proactively before any such rebuild; the
  // picker's own live onChange never triggers a rebuild, so dragging keeps
  // working uninterrupted. Reused by any 'color' param row today; exposed as
  // RSTR.ui.openColorPicker(anchorEl, hex, onChange) so a future control
  // (e.g. gradient stops) can call the same picker.
  //
  // Pure hex <-> hsv helpers (no DOM/ui.state) — reusable on their own.
  ui.clamp01 = function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }
  ui.normalizeHex = function normalizeHex(input) {
    let s = String(input == null ? '' : input).trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return '#' + s.toLowerCase();
  }
  ui.hexToRgb = function hexToRgb(hex) {
    const n = ui.normalizeHex(hex) || '#000000';
    const v = parseInt(n.slice(1), 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
  }
  ui.rgbToHex = function rgbToHex(r, g, b) {
    const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b);
  }
  ui.rgbToHsv = function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max === 0 ? 0 : d / max, v: max };
  }
  ui.hsvToRgb = function hsvToRgb(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r1 = 0, g1 = 0, b1 = 0;
    if (h < 60) { r1 = c; g1 = x; b1 = 0; }
    else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
    else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
    else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
    else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
    else { r1 = c; g1 = 0; b1 = x; }
    return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
  }
  ui.hexToHsv = function hexToHsv(hex) {
    const { r, g, b } = ui.hexToRgb(hex);
    return ui.rgbToHsv(r, g, b);
  }
  ui.hsvToHex = function hsvToHex(h, s, v) {
    const { r, g, b } = ui.hsvToRgb(h, s, v);
    return ui.rgbToHex(r, g, b);
  }

  // singleton popover state — built lazily on first open()
  ui.cp = { built: false, hsv: { h: 0, s: 0, v: 1 }, onChange: null, anchor: null, svW: 148, svH: 148, hueW: 148, hueH: 14 };

  ui.buildColorPicker = function buildColorPicker() {
    if (ui.cp.built) return;
    const pop = document.createElement('div');
    pop.id = 'color-picker-popover';

    const svWrap = document.createElement('div');
    svWrap.className = 'cp-sv-wrap';
    const svCanvas = document.createElement('canvas');
    svCanvas.className = 'cp-sv-canvas';
    svCanvas.width = ui.cp.svW;
    svCanvas.height = ui.cp.svH;
    const svCursor = document.createElement('div');
    svCursor.className = 'cp-marker';
    svWrap.append(svCanvas, svCursor);

    const hueWrap = document.createElement('div');
    hueWrap.className = 'cp-hue-wrap';
    const hueCanvas = document.createElement('canvas');
    hueCanvas.className = 'cp-hue-canvas';
    hueCanvas.width = ui.cp.hueW;
    hueCanvas.height = ui.cp.hueH;
    const hueCursor = document.createElement('div');
    hueCursor.className = 'cp-marker';
    hueWrap.append(hueCanvas, hueCursor);

    const hexRow = document.createElement('div');
    hexRow.className = 'cp-hex-row';
    const hexPreview = document.createElement('span');
    hexPreview.className = 'cp-hex-preview';
    const hexInput = document.createElement('input');
    hexInput.type = 'text';
    hexInput.className = 'cp-hex-input';
    hexInput.spellcheck = false;
    hexRow.append(hexPreview, hexInput);

    pop.append(svWrap, hueWrap, hexRow);
    ui.els.panel.appendChild(pop);

    ui.cp.pop = pop;
    ui.cp.svCanvas = svCanvas;
    ui.cp.svCtx = svCanvas.getContext('2d');
    ui.cp.svCursor = svCursor;
    ui.cp.hueCanvas = hueCanvas;
    ui.cp.hueCtx = hueCanvas.getContext('2d');
    ui.cp.hueCursor = hueCursor;
    ui.cp.hexInput = hexInput;
    ui.cp.hexPreview = hexPreview;
    ui.cp.built = true;

    ui.wireColorPickerDrag();
  }

  ui.paintSV = function paintSV() {
    const { h } = ui.cp.hsv;
    const img = ui.cp.svCtx.createImageData(ui.cp.svW, ui.cp.svH);
    for (let y = 0; y < ui.cp.svH; y++) {
      const v = 1 - y / (ui.cp.svH - 1);
      for (let x = 0; x < ui.cp.svW; x++) {
        const s = x / (ui.cp.svW - 1);
        const { r, g, b } = ui.hsvToRgb(h, s, v);
        const i = (y * ui.cp.svW + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    ui.cp.svCtx.putImageData(img, 0, 0);
  }

  ui.paintHue = function paintHue() {
    const img = ui.cp.hueCtx.createImageData(ui.cp.hueW, ui.cp.hueH);
    for (let x = 0; x < ui.cp.hueW; x++) {
      const h = (x / (ui.cp.hueW - 1)) * 360;
      const { r, g, b } = ui.hsvToRgb(h, 1, 1);
      for (let y = 0; y < ui.cp.hueH; y++) {
        const i = (y * ui.cp.hueW + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    ui.cp.hueCtx.putImageData(img, 0, 0);
  }

  ui.syncColorPickerUI = function syncColorPickerUI() {
    const { h, s, v } = ui.cp.hsv;
    ui.cp.svCursor.style.left = s * ui.cp.svW + 'px';
    ui.cp.svCursor.style.top = (1 - v) * ui.cp.svH + 'px';
    ui.cp.hueCursor.style.left = (h / 360) * ui.cp.hueW + 'px';
    ui.cp.hueCursor.style.top = ui.cp.hueH / 2 + 'px';
    const hex = ui.hsvToHex(h, s, v);
    ui.cp.hexInput.value = hex;
    ui.cp.hexPreview.style.background = hex;
  }

  ui.emitColorChange = function emitColorChange() {
    const { h, s, v } = ui.cp.hsv;
    if (ui.cp.onChange) ui.cp.onChange(ui.hsvToHex(h, s, v));
  }

  ui.wireColorPickerDrag = function wireColorPickerDrag() {
    function svFromEvent(e) {
      const rect = ui.cp.svCanvas.getBoundingClientRect();
      ui.cp.hsv.s = ui.clamp01((e.clientX - rect.left) / rect.width);
      ui.cp.hsv.v = 1 - ui.clamp01((e.clientY - rect.top) / rect.height);
    }
    let svDrag = null;
    ui.cp.svCanvas.addEventListener('pointerdown', (e) => {
      ui.cp.svCanvas.setPointerCapture(e.pointerId);
      svDrag = e.pointerId;
      svFromEvent(e);
      ui.syncColorPickerUI();
      ui.emitColorChange();
    });
    ui.cp.svCanvas.addEventListener('pointermove', (e) => {
      if (svDrag !== e.pointerId) return;
      svFromEvent(e);
      ui.syncColorPickerUI();
      ui.emitColorChange();
    });
    const svRelease = (e) => { if (svDrag === e.pointerId) svDrag = null; };
    ui.cp.svCanvas.addEventListener('pointerup', svRelease);
    ui.cp.svCanvas.addEventListener('pointercancel', svRelease);

    function hueFromEvent(e) {
      const rect = ui.cp.hueCanvas.getBoundingClientRect();
      ui.cp.hsv.h = ui.clamp01((e.clientX - rect.left) / rect.width) * 360;
    }
    let hueDrag = null;
    ui.cp.hueCanvas.addEventListener('pointerdown', (e) => {
      ui.cp.hueCanvas.setPointerCapture(e.pointerId);
      hueDrag = e.pointerId;
      hueFromEvent(e);
      ui.paintSV();
      ui.syncColorPickerUI();
      ui.emitColorChange();
    });
    ui.cp.hueCanvas.addEventListener('pointermove', (e) => {
      if (hueDrag !== e.pointerId) return;
      hueFromEvent(e);
      ui.paintSV();
      ui.syncColorPickerUI();
      ui.emitColorChange();
    });
    const hueRelease = (e) => { if (hueDrag === e.pointerId) hueDrag = null; };
    ui.cp.hueCanvas.addEventListener('pointerup', hueRelease);
    ui.cp.hueCanvas.addEventListener('pointercancel', hueRelease);

    function commitHexInput() {
      const norm = ui.normalizeHex(ui.cp.hexInput.value);
      if (!norm) {
        ui.cp.hexInput.value = ui.hsvToHex(ui.cp.hsv.h, ui.cp.hsv.s, ui.cp.hsv.v); // invalid — restore, no-op
        return;
      }
      ui.cp.hsv = ui.hexToHsv(norm);
      ui.paintSV();
      ui.syncColorPickerUI();
      ui.emitColorChange();
    }
    ui.cp.hexInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commitHexInput();
        ui.cp.hexInput.blur();
      }
    });
    ui.cp.hexInput.addEventListener('blur', commitHexInput);

    // outside pointerdown / Esc closes — ignore clicks inside the popover or on its own anchor
    document.addEventListener('pointerdown', (e) => {
      if (!ui.cp.pop || ui.cp.pop.style.display === 'none') return;
      if (ui.cp.pop.contains(e.target) || e.target === ui.cp.anchor) return;
      ui.closeColorPicker();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && ui.cp.pop && ui.cp.pop.style.display !== 'none') ui.closeColorPicker();
    });
  }

  // Position relative to #panel (position:relative); opens upward if it
  // would clip the viewport bottom.
  ui.positionColorPicker = function positionColorPicker(anchorEl) {
    ui.cp.pop.style.visibility = 'hidden';
    ui.cp.pop.style.display = 'block';
    const panelRect = ui.els.panel.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const popW = ui.cp.pop.offsetWidth;
    const popH = ui.cp.pop.offsetHeight;
    let left = anchorRect.left - panelRect.left;
    left = Math.max(4, Math.min(left, panelRect.width - popW - 4));
    let top;
    if (anchorRect.bottom + popH + 6 > window.innerHeight) {
      top = anchorRect.top - panelRect.top - popH - 4; // clips bottom -> open upward
    } else {
      top = anchorRect.bottom - panelRect.top + 4;
    }
    ui.cp.pop.style.left = left + 'px';
    ui.cp.pop.style.top = top + 'px';
    ui.cp.pop.style.visibility = '';
  }

  ui.openColorPicker = function openColorPicker(anchorEl, hex, onChange) {
    ui.buildColorPicker();
    ui.cp.anchor = anchorEl;
    ui.cp.onChange = onChange;
    ui.cp.hsv = ui.hexToHsv(hex);
    ui.paintHue();
    ui.paintSV();
    ui.syncColorPickerUI();
    ui.positionColorPicker(anchorEl);
  }

  ui.closeColorPicker = function closeColorPicker() {
    if (ui.cp.pop) ui.cp.pop.style.display = 'none';
    ui.cp.anchor = null;
    ui.cp.onChange = null;
  }
})((window.RSTR = window.RSTR || {}));
