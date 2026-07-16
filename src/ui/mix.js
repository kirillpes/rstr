// ui/mix.js — mix
(function (RSTR) {
  'use strict';
  const ui = RSTR.ui;

  // ---------- ADD (NEW mode only) ----------
  // PRE is no longer glued to the next ADDed effect — it's its own
  // independent, auto-committed layer (see reconcilePreLayer) that lives
  // entirely outside this flow now.
  ui.addToMix = function addToMix() {
    if (ui.state.editTarget.kind !== 'new') return;
    const effectId = ui.state.editTarget.effect;
    ui.state.mix.push({ effect: effectId, enabled: true, params: { ...ui.state.editTarget.params } });
    // Jump straight to EDIT on the committed layer — staying in NEW mode would
    // keep the picked effect previewed ON TOP of the layer just added, i.e.
    // the effect applied twice until the user clicks elsewhere.
    ui.selectLayer(ui.state.mix.length - 1);
    ui.showToast(`Added ${RSTR.getEffect(effectId).name} to mix`);
  }

  // ---------- mix stack (pinned OUTPUT + effect layers) ----------
  ui.iconButton = function iconButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  // Layer-level opacity lives on the mix row itself (not the edit panel) —
  // read/write straight through to the layer object. `opacity` is only
  // present on a layer once dialed below 100%, see preset.js.
  ui.mixLayerOpacity = function mixLayerOpacity(index) {
    const v = ui.state.mix[index].opacity;
    return v != null ? v : 1;
  }
  ui.setMixLayerOpacity = function setMixLayerOpacity(index, v) {
    ui.state.mix[index].opacity = v;
  }

  // Layer-level blend mode — same reasoning as opacity above: it's a
  // property of the LAYER (how it composites into the stack), not of the
  // effect, so it lives on the mix row, not the edit panel. `blend` is only
  // present on a layer once it's not 'normal', see preset.js.
  ui.mixLayerBlend = function mixLayerBlend(index) {
    return ui.state.mix[index].blend || 'normal';
  }
  ui.setMixLayerBlend = function setMixLayerBlend(index, v) {
    ui.state.mix[index].blend = v;
  }

  // Layer-level MASK flag — presence of `mask` on the layer object IS the
  // flag (no nested `enabled`), same convention src/preset.js's
  // normalizeMask uses for serialization. A mask layer is never composited;
  // see src/pipeline.js render() and this file's ui.computeMaskInfo() below for
  // which OTHER row it feeds.
  ui.mixLayerMaskOn = function mixLayerMaskOn(index) {
    const m = ui.state.mix[index].mask;
    return !!(m && typeof m === 'object');
  }
  ui.mixLayerMaskInvert = function mixLayerMaskInvert(index) {
    const m = ui.state.mix[index].mask;
    return !!(m && m.invert === true);
  }
  ui.setMixLayerMask = function setMixLayerMask(index, on) {
    if (on) ui.state.mix[index].mask = { invert: ui.mixLayerMaskInvert(index) }; // preserve a prior invert choice if re-toggled
    else delete ui.state.mix[index].mask;
  }
  ui.setMixLayerMaskInvert = function setMixLayerMaskInvert(index, invert) {
    if (!ui.state.mix[index].mask) ui.state.mix[index].mask = {};
    ui.state.mix[index].mask.invert = !!invert;
  }

  // Mirrors src/pipeline.js render()'s mask-consumption rule exactly, over
  // ui.state.mix, so the LAYERS panel can show which row is being masked (and
  // which mask rows are dead weight) without re-deriving the logic. Walking
  // only the ENABLED layers (matching the pipeline's own `enabled` filter):
  // a mask layer's flag applies to the next enabled, non-mask layer
  // (`targets`); two masks in a row -> the earlier one is superseded, and a
  // trailing mask with nothing after it is never consumed -- both land in
  // `noop` (the UI's "no target" marker, see buildMixList).
  ui.computeMaskInfo = function computeMaskInfo() {
    const targets = new Set();
    const noop = new Set();
    let pendingIndex = -1;
    ui.state.mix.forEach((step, index) => {
      if (step.enabled === false) return;
      if (ui.mixLayerMaskOn(index)) {
        if (pendingIndex >= 0) noop.add(pendingIndex); // superseded by this later mask
        pendingIndex = index;
      } else if (pendingIndex >= 0) {
        targets.add(index);
        pendingIndex = -1;
      }
    });
    if (pendingIndex >= 0) noop.add(pendingIndex); // trailing mask, nothing after it
    return { targets, noop };
  }

  // Source (pinned "◇ ORIGINAL" row) opacity — same read/write-straight-
  // through shape as mixLayerOpacity above, just on ui.state.source instead of
  // a mix layer (there's only ever one).
  ui.sourceOpacity = function sourceOpacity() {
    const v = ui.state.source.opacity;
    return v != null ? v : 1;
  }
  ui.setSourceOpacity = function setSourceOpacity(v) {
    ui.state.source.opacity = v;
  }

  // ---------- blend-mode dropdown (custom popover — live preview on hover) ----------
  // A native <select> can't do this: the browser owns the option popup and
  // fires no hover events on <option>s. Brutalist replacement — 1px-bordered
  // rows, same grouping the old <optgroup>s gave — that previews a blend
  // mode on the canvas the instant you hover a row, and reverts the instant
  // you leave without clicking. Singleton popover (same idiom as the HSV
  // color picker above: built once, re-targeted per open, appended to
  // #panel so a ui.buildMixList() rebuild of the row underneath never orphans
  // it while it's open).
  ui.bd = {
    built: false,
    open: false,
    pop: null,
    rows: [], // [{ id, el }] flat, in RSTR.preset.BLEND_MODES order
    anchor: null,
    committed: 'normal', // the value to revert to on Esc/outside-click/mouse-away
    highlighted: 'normal',
    previewed: false, // true once a hover/key actually mutated live state — guards
    // against a stray commit-string ('normal') write when the user opens and
    // closes the dropdown without ever touching a row.
    onPreview: null, // (id) => void — mutate live state + ui.requestRender(), never persists
    onCommit: null, // (id) => void — mutate live state + ui.requestRender() + refresh label
  };

  ui.blendLabel = function blendLabel(id) {
    const m = RSTR.preset.BLEND_MODES.find((x) => x.id === id);
    return m ? m.label : id;
  }

  ui.setBlendHighlight = function setBlendHighlight(id) {
    ui.bd.highlighted = id;
    for (const r of ui.bd.rows) r.el.classList.toggle('highlighted', r.id === id);
  }

  ui.previewBlendRow = function previewBlendRow(id) {
    ui.setBlendHighlight(id);
    ui.bd.previewed = true;
    if (ui.bd.onPreview) ui.bd.onPreview(id);
  }

  ui.commitBlendRow = function commitBlendRow(id) {
    ui.bd.committed = id;
    if (ui.bd.onCommit) ui.bd.onCommit(id);
    ui.closeBlendDropdown(false);
  }

  ui.moveBlendHighlight = function moveBlendHighlight(delta) {
    const ids = ui.bd.rows.map((r) => r.id);
    let idx = ids.indexOf(ui.bd.highlighted);
    if (idx < 0) idx = ids.indexOf(ui.bd.committed);
    idx = Math.max(0, Math.min(ids.length - 1, idx + delta));
    ui.previewBlendRow(ids[idx]);
    ui.bd.rows[idx].el.scrollIntoView({ block: 'nearest' });
  }

  ui.buildBlendDropdown = function buildBlendDropdown() {
    if (ui.bd.built) return;
    const pop = document.createElement('div');
    pop.id = 'blend-dd-popover';
    ui.els.panel.appendChild(pop);
    ui.bd.pop = pop;
    ui.bd.built = true;

    let currentGroup; // undefined sentinel; BLEND_MODES' first entry has group ''
    for (const m of RSTR.preset.BLEND_MODES) {
      if (m.group !== currentGroup) {
        currentGroup = m.group;
        if (m.group) {
          const label = document.createElement('div');
          label.className = 'blend-dd-group';
          label.textContent = m.group;
          pop.appendChild(label);
        }
      }
      const row = document.createElement('div');
      row.className = 'blend-dd-row';
      row.textContent = m.label;
      row.addEventListener('pointerenter', () => ui.previewBlendRow(m.id));
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        ui.commitBlendRow(m.id);
      });
      pop.appendChild(row);
      ui.bd.rows.push({ id: m.id, el: row });
    }

    // Leaving the whole menu (pointerleave doesn't fire when moving between
    // child rows, only when the pointer actually exits the popover) with
    // nothing clicked = revert the live preview to the committed mode; the
    // menu itself stays open — only Esc/outside-click closes it.
    pop.addEventListener('pointerleave', () => {
      if (!ui.bd.open) return;
      ui.setBlendHighlight(ui.bd.committed);
      if (ui.bd.previewed) ui.bd.onPreview(ui.bd.committed);
    });

    // Singleton document listeners, wired once — gated on ui.bd.open so they're
    // no-ops the rest of the time (same pattern as the color picker's).
    document.addEventListener('pointerdown', (e) => {
      if (!ui.bd.open) return;
      if (ui.bd.pop.contains(e.target) || e.target === ui.bd.anchor) return;
      ui.closeBlendDropdown(true);
    });
    document.addEventListener('keydown', (e) => {
      if (!ui.bd.open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        ui.closeBlendDropdown(true);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        ui.moveBlendHighlight(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        ui.moveBlendHighlight(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        ui.commitBlendRow(ui.bd.highlighted);
      }
    });
  }

  // Position relative to #panel — same anchoring convention as
  // positionColorPicker: opens below the trigger, flips upward if it would
  // clip the viewport bottom.
  ui.positionBlendDropdown = function positionBlendDropdown(anchorEl) {
    ui.bd.pop.style.visibility = 'hidden';
    ui.bd.pop.style.display = 'block';
    const panelRect = ui.els.panel.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const popW = ui.bd.pop.offsetWidth;
    const popH = ui.bd.pop.offsetHeight;
    let left = anchorRect.left - panelRect.left;
    left = Math.max(4, Math.min(left, panelRect.width - popW - 4));
    let top;
    if (anchorRect.bottom + popH + 6 > window.innerHeight) {
      top = anchorRect.top - panelRect.top - popH - 4; // clips bottom -> open upward
    } else {
      top = anchorRect.bottom - panelRect.top + 4;
    }
    ui.bd.pop.style.left = left + 'px';
    ui.bd.pop.style.top = top + 'px';
    ui.bd.pop.style.visibility = '';
  }

  ui.openBlendDropdown = function openBlendDropdown(anchorEl, currentId, onPreview, onCommit) {
    ui.buildBlendDropdown();
    ui.bd.anchor = anchorEl;
    ui.bd.committed = currentId;
    ui.bd.previewed = false;
    ui.bd.onPreview = onPreview;
    ui.bd.onCommit = onCommit;
    ui.bd.open = true;
    anchorEl.classList.add('open');
    ui.setBlendHighlight(currentId);
    ui.positionBlendDropdown(anchorEl);
  }

  ui.closeBlendDropdown = function closeBlendDropdown(revert) {
    if (!ui.bd.open) return;
    ui.bd.open = false;
    // Only touch live state if a preview actually ran — opening and closing
    // without ever hovering a row must leave state byte-for-byte untouched.
    if (revert && ui.bd.previewed && ui.bd.onPreview) ui.bd.onPreview(ui.bd.committed);
    ui.bd.pop.style.display = 'none';
    if (ui.bd.anchor) ui.bd.anchor.classList.remove('open');
    ui.bd.anchor = null;
    ui.bd.onPreview = null;
    ui.bd.onCommit = null;
    ui.bd.previewed = false;
  }

  // Per-row trigger button — replaces the old native <select>. get/set
  // follow the same closure idiom as the opacity scrub below.
  ui.makeBlendControl = function makeBlendControl(getValue, setValue) {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'mix-blend blend-dd-trigger';
    trigger.title = 'Blend mode';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'blend-dd-label';
    const caret = document.createElement('span');
    caret.className = 'blend-dd-caret';
    caret.textContent = '▾';
    trigger.append(labelSpan, caret);

    function refresh() {
      labelSpan.textContent = ui.blendLabel(getValue());
    }
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (ui.bd.open && ui.bd.anchor === trigger) {
        ui.closeBlendDropdown(true);
        return;
      }
      ui.openBlendDropdown(
        trigger,
        getValue(),
        (id) => {
          setValue(id);
          ui.requestRender();
        },
        (id) => {
          setValue(id);
          ui.requestRender();
          refresh();
        }
      );
    });
    refresh();
    trigger.refresh = refresh;
    return trigger;
  }

  // ---------- LAYERS drag-to-reorder (native HTML5 DnD, same idiom as the
  // /Effects list above: a 1px insertion line via .drop-before/.drop-after,
  // no library) ----------
  // 2026-07-13 (user feedback): the whole row is the drag SOURCE now, not a
  // dedicated grip — a mix row still carries several of its own interactive
  // children (eye toggle, ✕, MASK/INV, the blend trigger, the opacity scrub
  // — itself a click-drag control) that need ordinary mousedown/click
  // behavior, not a hijacked native drag. Solved generically, not with
  // per-control hacks: ui.wireMixRowDragToggle() below flips `row.draggable`
  // off while the pointer is down over one of them (closest() against one
  // selector list) and restores it on release — see its own comment for why
  // capture phase matters. dragover/drop stay on the row (and the two
  // pinned rows) so hovering anywhere over it still tracks the insertion
  // point.
  ui.mixDragIndex = null;

  ui.clearMixDropIndicators = function clearMixDropIndicators() {
    const scope = ui.els.mixList;
    if (!scope) return;
    scope.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
      el.classList.remove('drop-before', 'drop-after');
    });
  }

  // Interactive children of a mix row that must keep their own
  // mousedown/click/drag gestures instead of starting a row reorder-drag:
  // the opacity scrub (`.scrub` — covers its click-to-type `<input>` too,
  // since closest() walks up from it to the ancestor), any icon button
  // (eye/✕/MASK/INV all share `.icon-btn`), and the blend-mode trigger
  // (`.mix-blend`).
  const MIX_ROW_INTERACTIVE_SELECTOR = '.scrub, .icon-btn, .mix-blend';

  // Recomputes `row.draggable` on every pointerdown/mousedown: false when
  // the pointer landed on an interactive child, true otherwise — so a plain
  // press on the row body still starts a native drag, and a press on a
  // control never does. Restored to true unconditionally on release too, as
  // a self-healing fallback. Listened in the CAPTURE phase: the opacity
  // scrub's own click-to-type readout calls stopPropagation() on ITS
  // pointerdown (see makeScrub above), so a bubble-phase listener on the row
  // would never see that event and would leave the row draggable while the
  // user is dragging the scrub's value.
  ui.wireMixRowDragToggle = function wireMixRowDragToggle(row) {
    const recompute = (e) => {
      row.draggable = !e.target.closest(MIX_ROW_INTERACTIVE_SELECTOR);
    };
    const restore = () => {
      row.draggable = true;
    };
    row.addEventListener('pointerdown', recompute, true);
    row.addEventListener('mousedown', recompute, true);
    row.addEventListener('pointerup', restore, true);
    row.addEventListener('mouseup', restore, true);
    row.addEventListener('dragend', restore);
  }

  // Reorders ui.state.mix. `to` is an insertion index in ORIGINAL (pre-removal)
  // coordinates: `to === i` lands right before the current index-i layer,
  // `to === ui.state.mix.length` lands at the very end. Tracks the currently
  // EDITed layer by object identity (not index) so a reorder never silently
  // jumps EDIT onto a different layer.
  ui.moveLayerTo = function moveLayerTo(from, to) {
    if (to === from || to === from + 1) return; // dropped back where it started
    const selectedStep = ui.state.editTarget.kind === 'layer' ? ui.state.mix[ui.state.editTarget.index] : null;
    const [moved] = ui.state.mix.splice(from, 1);
    const insertAt = from < to ? to - 1 : to;
    ui.state.mix.splice(insertAt, 0, moved);
    if (selectedStep) {
      const newIndex = ui.state.mix.indexOf(selectedStep);
      if (newIndex >= 0 && newIndex !== ui.state.editTarget.index) {
        ui.state.editTarget.index = newIndex;
        ui.buildEditor(); // refresh the [n] index in the header
      }
    }
    ui.buildMixList();
    ui.requestRender();
  }

  // ---------- eye affordance (replaces the old enable/disable checkbox) ----------
  // Same underlying boolean (layer.enabled / ui.state.outputEnabled /
  // ui.state.source.enabled) — just rendered as show/hide instead of a native
  // checkbox, so it matches every other brutalist control (no browser
  // checkbox chrome, no accent color). Open eye = visible; eye+slash = hidden.
  ui.eyeIconSVG = function eyeIconSVG(hidden) {
    return (
      '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' +
      '<path d="M1 6C1 6 4 2.4 6 2.4C8 2.4 11 6 11 6C11 6 8 9.6 6 9.6C4 9.6 1 6 1 6Z" fill="none" stroke="currentColor" stroke-width="1"/>' +
      '<circle cx="6" cy="6" r="1.2" fill="currentColor" stroke="none"/>' +
      (hidden ? '<line x1="1.2" y1="1.2" x2="10.8" y2="10.8" stroke="currentColor" stroke-width="1"/>' : '') +
      '</svg>'
    );
  }

  ui.makeEyeToggle = function makeEyeToggle(title, getVisible, toggle) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn eye-btn';
    btn.title = title;
    const sync = () => {
      btn.innerHTML = ui.eyeIconSVG(!getVisible());
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
      sync();
    });
    sync();
    return btn;
  }

  ui.buildMixList = function buildMixList() {
    const container = ui.els.mixList;
    container.innerHTML = '';

    // pinned OUTPUT layer (runs first: crop/scale before effects) — never
    // gets an opacity scrub, it's not a blendable effect layer. Not
    // draggable and not displaceable (see the LAYERS drag-to-reorder block
    // above) — it only ever accepts a dragged layer landing right under it.
    const outItem = document.createElement('div');
    outItem.className =
      'mix-item output-layer' +
      (ui.state.editTarget.kind === 'output' ? ' selected' : '') +
      (ui.state.outputEnabled ? '' : ' disabled');
    const outTop = document.createElement('div');
    outTop.className = 'mix-row-top';
    const outEye = ui.makeEyeToggle('Enable/disable crop + scale', () => ui.state.outputEnabled, () => {
      ui.state.outputEnabled = !ui.state.outputEnabled;
      outItem.classList.toggle('disabled', !ui.state.outputEnabled);
      ui.requestOutput();
    });
    const outTitle = document.createElement('span');
    outTitle.className = 'mix-title';
    outTitle.textContent = '◇ OUTPUT';
    outTop.append(outEye, outTitle);
    outItem.append(outTop);
    outItem.addEventListener('click', ui.selectOutput);
    // Drop target only — OUTPUT is pinned, so a dragged layer can only ever
    // land right after it (becomes the new first layer, index 0).
    outItem.addEventListener('dragover', (e) => {
      if (ui.mixDragIndex === null) return;
      e.preventDefault();
      ui.clearMixDropIndicators();
      outItem.classList.add('drop-after');
    });
    outItem.addEventListener('drop', (e) => {
      if (ui.mixDragIndex === null) return;
      e.preventDefault();
      const from = ui.mixDragIndex;
      ui.clearMixDropIndicators();
      ui.mixDragIndex = null;
      ui.moveLayerTo(from, 0);
    });
    container.appendChild(outItem);

    // effect layers
    const maskInfo = ui.computeMaskInfo();
    ui.state.mix.forEach((step, index) => {
      const def = RSTR.getEffect(step.effect);
      const isMask = ui.mixLayerMaskOn(index);
      const isMaskTarget = maskInfo.targets.has(index);
      const isMaskNoop = maskInfo.noop.has(index);
      const item = document.createElement('div');
      item.className =
        'mix-item' +
        (step.enabled === false ? ' disabled' : '') +
        (isMask ? ' mask-layer' : '') +
        (isMaskTarget ? ' mask-target' : '') +
        (ui.state.editTarget.kind === 'layer' && ui.state.editTarget.index === index ? ' selected' : '');

      const top = document.createElement('div');
      top.className = 'mix-row-top';

      const eyeBtn = ui.makeEyeToggle('Show/hide layer', () => step.enabled !== false, () => {
        const wasVisible = step.enabled !== false;
        step.enabled = !wasVisible;
        item.classList.toggle('disabled', step.enabled === false);
        ui.requestRender();
      });

      const title = document.createElement('span');
      title.className = 'mix-title';
      title.textContent = `${index + 1}. ${def.name}`;

      const controls = document.createElement('div');
      controls.className = 'mix-controls';
      controls.append(ui.iconButton('✕', 'Remove', () => ui.removeLayer(index)));

      top.append(eyeBtn, title);
      // Subtle marker on the row being masked (the next enabled, non-mask
      // layer after a MASK row) — see ui.computeMaskInfo(). Never shown on a
      // mask row itself (isMask rows read as "not drawn" via .mask-layer's
      // dashed border + italic title instead, below).
      if (isMaskTarget) {
        const maskedBadge = document.createElement('span');
        maskedBadge.className = 'mix-badge';
        maskedBadge.textContent = 'MASKED';
        maskedBadge.title = 'Blend opacity is multiplied by the MASK layer above, per pixel';
        top.append(maskedBadge);
      }
      top.append(controls);
      item.append(top);

      // Row 2: MASK + INVERT toggles (left), then either blend+opacity (a
      // normal layer's compositing controls) or a subtle "stencil, not
      // drawn" note (a mask layer's own blend/opacity are unused — see
      // src/pipeline.js render()'s isMaskLayer branch). Own hit area on
      // every control — stops propagation so using them doesn't also jump
      // EDIT to this layer.
      const controlsRow = document.createElement('div');
      controlsRow.className = 'mix-controls-row';

      const maskBtn = document.createElement('button');
      maskBtn.type = 'button';
      maskBtn.className = 'icon-btn mix-mask-btn' + (isMask ? ' active' : '');
      maskBtn.textContent = 'MASK';
      maskBtn.title = 'Use as a MASK — not drawn itself; its luminance stencils the NEXT layer';
      maskBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        ui.setMixLayerMask(index, !isMask);
        ui.buildMixList(); // a mask flag can change the MASKED badge on ANOTHER row too
        ui.requestRender();
      });
      controlsRow.append(maskBtn);

      if (isMask) {
        const invertBtn = document.createElement('button');
        invertBtn.type = 'button';
        invertBtn.className = 'icon-btn mix-mask-btn' + (ui.mixLayerMaskInvert(index) ? ' active' : '');
        invertBtn.textContent = 'INV';
        invertBtn.title = 'Invert the mask (stipple/dither marks are black — invert to reveal through them)';
        invertBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          ui.setMixLayerMaskInvert(index, !ui.mixLayerMaskInvert(index));
          ui.buildMixList();
          ui.requestRender();
        });
        controlsRow.append(invertBtn);

        const note = document.createElement('span');
        note.className = 'mix-mask-note';
        note.textContent = isMaskNoop ? 'stencil — no target, no-op' : 'stencil — feeds next layer';
        controlsRow.append(note);
      } else {
        // makeBlendControl's own trigger click handler already stops
        // propagation (so opening the dropdown doesn't also jump EDIT to
        // this row via the item's click listener below).
        const blendControl = ui.makeBlendControl(
          () => ui.mixLayerBlend(index),
          (v) => ui.setMixLayerBlend(index, v)
        );

        const opacityScrub = ui.makeScrub({
          label: 'Opacity',
          min: 0,
          max: 100,
          step: 1,
          get: () => Math.round(ui.mixLayerOpacity(index) * 100),
          set: (v) => {
            ui.setMixLayerOpacity(index, v / 100);
            ui.requestRender();
          },
          format: (v) => v + '%',
          reset: 100,
        });
        opacityScrub.classList.add('mix-opacity');
        opacityScrub.addEventListener('click', (e) => e.stopPropagation());

        controlsRow.append(blendControl, opacityScrub);
      }
      item.append(controlsRow);

      // Whole row is the drag SOURCE (see wireMixRowDragToggle above for how
      // its own interactive children opt out) as well as the drop target —
      // dragover/drop live on the row so hovering anywhere over it shows the
      // insertion line.
      item.draggable = true;
      ui.wireMixRowDragToggle(item);
      item.addEventListener('dragstart', (e) => {
        ui.mixDragIndex = index;
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('text/plain', 'layer:' + index);
        } catch {
          /* non-fatal — some embedders restrict dataTransfer */
        }
      });
      item.addEventListener('dragend', () => {
        ui.mixDragIndex = null;
        ui.clearMixDropIndicators();
      });
      item.addEventListener('dragover', (e) => {
        if (ui.mixDragIndex === null || ui.mixDragIndex === index) return;
        e.preventDefault();
        const rect = item.getBoundingClientRect();
        const before = e.clientY - rect.top < rect.height / 2;
        ui.clearMixDropIndicators();
        item.classList.add(before ? 'drop-before' : 'drop-after');
      });
      item.addEventListener('drop', (e) => {
        if (ui.mixDragIndex === null || ui.mixDragIndex === index) return;
        e.preventDefault();
        const rect = item.getBoundingClientRect();
        const before = e.clientY - rect.top < rect.height / 2;
        const from = ui.mixDragIndex;
        ui.clearMixDropIndicators();
        ui.mixDragIndex = null;
        ui.moveLayerTo(from, before ? index : index + 1);
      });

      // A genuine drag (dragstart fired) never produces a trailing 'click' —
      // native HTML5 DnD suppresses it — so this plain click listener only
      // ever fires for an actual press-and-release: safe to always select.
      item.addEventListener('click', () => ui.selectLayer(index));
      container.appendChild(item);
    });

    // pinned SOURCE layer (a BASE PLATE composited UNDER the finished stack
    // as a final pass) — the mirror of ◇ OUTPUT above, but pinned at the
    // BOTTOM since ORIGINAL is the stack's backdrop rather than its final
    // crop/scale. Not part of ui.state.mix, not draggable/deletable, no blend
    // control (it's a fixed source-over composite, not a blendable effect
    // layer) and no edit panel — its only controls are inline, right here,
    // same as a mix layer's own opacity scrub. Starts UNCHECKED by design
    // (see ui.state.source's own comment above and src/preset.js
    // normalizeSource): checking it makes the original photo show through
    // any transparent holes the stack punches (e.g. an alpha/alpha-invert
    // blend layer) instead of exporting them as transparency. See
    // src/pipeline.js render()'s final composite pass and src/preset.js's
    // `source` block.
    const srcItem = document.createElement('div');
    srcItem.className = 'mix-item source-layer' + (ui.state.source.enabled === true ? '' : ' disabled');

    const srcTop = document.createElement('div');
    srcTop.className = 'mix-row-top';
    const srcEye = ui.makeEyeToggle(
      'Show original underneath (fills transparent holes punched by the stack, e.g. alpha/alpha-invert blend)',
      () => ui.state.source.enabled === true,
      () => {
        ui.state.source.enabled = !(ui.state.source.enabled === true);
        srcItem.classList.toggle('disabled', ui.state.source.enabled !== true);
        ui.requestRender();
      }
    );
    const srcTitle = document.createElement('span');
    srcTitle.className = 'mix-title';
    srcTitle.textContent = '◇ ORIGINAL';
    srcTop.append(srcEye, srcTitle);
    srcItem.append(srcTop);

    // Drop target only — ORIGINAL is pinned at the bottom, so a dragged
    // layer can only ever land right above it (appended at the end).
    srcItem.addEventListener('dragover', (e) => {
      if (ui.mixDragIndex === null) return;
      e.preventDefault();
      ui.clearMixDropIndicators();
      srcItem.classList.add('drop-before');
    });
    srcItem.addEventListener('drop', (e) => {
      if (ui.mixDragIndex === null) return;
      e.preventDefault();
      const from = ui.mixDragIndex;
      ui.clearMixDropIndicators();
      ui.mixDragIndex = null;
      ui.moveLayerTo(from, ui.state.mix.length);
    });

    const srcControlsRow = document.createElement('div');
    srcControlsRow.className = 'mix-controls-row';
    const srcOpacityScrub = ui.makeScrub({
      label: 'Opacity',
      min: 0,
      max: 100,
      step: 1,
      get: () => Math.round(ui.sourceOpacity() * 100),
      set: (v) => {
        ui.setSourceOpacity(v / 100);
        ui.requestRender();
      },
      format: (v) => v + '%',
      reset: 100,
    });
    srcOpacityScrub.classList.add('mix-opacity');
    srcControlsRow.append(srcOpacityScrub);
    srcItem.append(srcControlsRow);

    container.appendChild(srcItem);
  }

  ui.removeLayer = function removeLayer(index) {
    const removed = ui.state.mix[index];
    ui.state.mix.splice(index, 1);
    if (removed === ui.preLayerRef) {
      // The user removed the committed PREPROCESS layer directly from the
      // stack (its own ✕ button) — release the PRE module back to its own
      // default instead of leaving it silently pointing at a layer that no
      // longer exists.
      ui.preLayerRef = null;
      ui.state.pre = RSTR.preset.defaultPre();
      ui.syncPreUI();
    }
    if (ui.state.editTarget.kind === 'layer') {
      if (ui.state.editTarget.index === index) {
        // was editing the removed layer — fall back to NEW mode on that effect
        ui.selectEffect(removed.effect);
        return;
      }
      if (ui.state.editTarget.index > index) ui.state.editTarget.index -= 1;
      ui.buildEditor(); // refresh the [n] index in the header
    }
    ui.buildMixList();
    ui.requestRender();
  }
})((window.RSTR = window.RSTR || {}));
