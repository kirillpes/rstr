// ui/core.js — shared editor state, history, render loop.
(function (RSTR) {
  'use strict';
  const ui = (RSTR.ui = RSTR.ui || {});

  ui.state = {
    mix: [], // committed effect layers: [{ effect, enabled, params }]
    // editTarget: { kind:'new', effect, params } | { kind:'layer', index } | { kind:'output' }
    editTarget: { kind: 'new', effect: RSTR.EFFECT_LIST[0].id, params: RSTR.defaultParams(RSTR.EFFECT_LIST[0].id) },
    output: RSTR.preset.defaultOutput(),
    outputEnabled: true, // UI toggle on the OUTPUT layer; off => passthrough
    imageName: 'rstr',
    disabled: new Set(), // effect ids hidden from the picker (loaded in boot)
    settingsOpen: false,
    pre: RSTR.preset.defaultPre(), // global PRE working buffer — mirrors the single committed PREPROCESS layer (ui.preLayerRef) at the FRONT of ui.state.mix once non-identity, see ui.reconcilePreLayer(); always expanded, no collapse state
    source: RSTR.preset.defaultSource(), // pinned "◇ ORIGINAL" row (bottom of LAYERS): {enabled, opacity} BASE PLATE composited under the finished stack as a final pass — NOT part of ui.state.mix, see ui.buildMixList()/src/pipeline.js render(). Defaults to enabled:false (see src/preset.js normalizeSource) so the checkbox starts UNCHECKED — turning it on for free would silently fill crt's transparent void and every other alpha-hole effect.
    // user-defined /Effects catalog order + grouping — persisted to
    // localStorage (rstr.effectOrder / rstr.effectGroups), loaded in boot via
    // ui.loadOrderState(). effectOrder mixes plain effect ids (top-level,
    // ungrouped rows) with group-anchor tokens "@group:<id>" marking where a
    // group header sits; a group's members live in its OWN `effects` array,
    // never duplicated at the top level. See ui.loadOrderState() for the
    // reconciliation that makes this robust to the registry changing.
    effectOrder: [],
    effectGroups: [], // [{ id, name, collapsed, effects: [id,…] }]
  };
  ui.pipeline = null;
  ui.outputDirty = false;
  ui.renderDirty = false;
  ui.els = {};

  // ---------- undo/redo history (Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y = redo alias) ----------
  // Debounced + diff-based snapshotting of the DOCUMENT — ui.state.mix, .output,
  // .outputEnabled, .pre, .source — NOT ui.state.editTarget (that's just the UI
  // cursor; undoing a param edit shouldn't also yank the user's selection
  // around). ui.scheduleHistorySync() is hooked into ui.requestRender()/
  // ui.requestOutput() below (fired by essentially every doc mutation) plus a
  // couple of mutators that never route through either — see those call
  // sites. The 300ms debounce coalesces a whole scrub drag into ONE undo
  // step; the diff against the last-recorded baseline makes redundant calls
  // harmless, so hooking liberally is cheap and safe.
  const HISTORY_LIMIT = 50;
  ui.histUndo = []; // JSON strings we can go BACK to
  ui.histRedo = []; // JSON strings we can go FORWARD to
  ui.histPresent = null; // JSON string of the current doc (the baseline)
  ui.histRestoring = false; // true while applyHistoryState runs — suppresses re-recording its own writes
  ui.histTimer = null;

  ui.docSnapshot = function docSnapshot() {
    return JSON.stringify({
      mix: ui.state.mix,
      output: ui.state.output,
      outputEnabled: ui.state.outputEnabled,
      pre: ui.state.pre,
      source: ui.state.source,
    });
  }

  ui.scheduleHistorySync = function scheduleHistorySync() {
    if (ui.histRestoring) return;
    if (ui.histTimer) clearTimeout(ui.histTimer);
    ui.histTimer = setTimeout(ui.commitHistoryIfChanged, 300);
  }

  ui.commitHistoryIfChanged = function commitHistoryIfChanged() {
    ui.histTimer = null;
    const cur = ui.docSnapshot();
    if (ui.histPresent === null) {
      ui.histPresent = cur; // first call anywhere — just establishes the baseline
      return;
    }
    if (cur === ui.histPresent) return; // debounce window elapsed but nothing actually changed
    ui.histUndo.push(ui.histPresent);
    if (ui.histUndo.length > HISTORY_LIMIT) ui.histUndo.shift();
    ui.histRedo = []; // a fresh edit invalidates the redo branch
    ui.histPresent = cur;
  }

  // Jumps the live doc to a stored snapshot and rewires every UI surface that
  // holds closures over the OLD mix/output/pre/source objects — the same
  // refresh set ui.applyStyle() uses when it swaps the whole doc (see
  // ui.applyStyle() below), because a history jump IS exactly that: a new
  // object graph, not just new values in the old one.
  ui.applyHistoryState = function applyHistoryState(json) {
    ui.histRestoring = true;
    const s = JSON.parse(json);
    ui.state.mix = s.mix;
    ui.state.output = s.output;
    ui.state.outputEnabled = s.outputEnabled;
    ui.state.pre = s.pre;
    ui.state.source = s.source;
    // Re-derive the committed PREPROCESS layer reference (front-of-stack),
    // same rule ui.applyStyle() uses — see ui.reconcilePreLayer()/ui.applyStyle().
    ui.preLayerRef = ui.state.mix.length && ui.state.mix[0].effect === 'preprocess' ? ui.state.mix[0] : null;
    // Keep editTarget valid: an undo/redo can put a 'layer' index out of range.
    if (ui.state.editTarget.kind === 'layer' && ui.state.editTarget.index >= ui.state.mix.length) {
      ui.state.editTarget = { kind: 'output' };
    }
    ui.buildEditor(); // rewires the edit panel (incl. the OUTPUT tab, via its own ui.buildOutputEditor() call) to the restored objects
    ui.buildEffectList(); // refresh the NEW-mode / picker highlight
    ui.buildMixList();
    ui.syncPreUI();
    ui.requestOutput();
    ui.histRestoring = false;
  }

  ui.historyUndo = function historyUndo() {
    if (ui.histTimer) ui.commitHistoryIfChanged(); // flush any pending (debounced) edit first
    if (!ui.histUndo.length) return;
    ui.histRedo.push(ui.histPresent);
    ui.histPresent = ui.histUndo.pop();
    ui.applyHistoryState(ui.histPresent);
  }
  ui.historyRedo = function historyRedo() {
    if (ui.histTimer) ui.commitHistoryIfChanged();
    if (!ui.histRedo.length) return;
    ui.histUndo.push(ui.histPresent);
    ui.histPresent = ui.histRedo.pop();
    ui.applyHistoryState(ui.histPresent);
  }

  ui.visibleEffectList = function visibleEffectList() {
    return RSTR.EFFECT_LIST.filter((d) => !d.internal && !ui.state.disabled.has(d.id));
  }

  // The output actually applied to preview/export/style: passthrough when the
  // OUTPUT layer is toggled off (keeps the schema unchanged — no `enabled` key).
  ui.effectiveOutput = function effectiveOutput() {
    return ui.state.outputEnabled ? ui.state.output : RSTR.preset.defaultOutput();
  }

  // ---------- edit-target helpers ----------
  ui.currentEffectId = function currentEffectId() {
    const t = ui.state.editTarget;
    if (t.kind === 'new') return t.effect;
    if (t.kind === 'layer') return ui.state.mix[t.index].effect;
    return null; // output
  }
  ui.currentParams = function currentParams() {
    const t = ui.state.editTarget;
    if (t.kind === 'new') return t.params;
    if (t.kind === 'layer') return ui.state.mix[t.index].params;
    return null;
  }
  ui.setCurrentParams = function setCurrentParams(params) {
    const t = ui.state.editTarget;
    if (t.kind === 'new') t.params = params;
    else if (t.kind === 'layer') ui.state.mix[t.index].params = params;
  }

  // Sets ONLY the "NEW · <fx>" / "EDIT · <fx> [n]" header text and the ADD TO
  // MIX button's visibility (shown in NEW, hidden once committed to a layer)
  // — the cheap subset of ui.buildEditor() below that never touches
  // #active-params. Used by ui.commitNewOnEdit() (and ui.reconcilePreLayer()'s
  // index bookkeeping) where a full ui.buildEditor() would tear down — and drop
  // the pointer capture on — the very scrub control an in-flight drag is
  // mutating.
  ui.refreshTargetHeader = function refreshTargetHeader() {
    const t = ui.state.editTarget;
    if (t.kind === 'output') {
      ui.els.targetHeader.textContent = 'EDIT · OUTPUT';
      return;
    }
    const def = RSTR.getEffect(ui.currentEffectId());
    ui.els.targetHeader.textContent = t.kind === 'new' ? `NEW · ${def.name}` : `EDIT · ${def.name} [${t.index + 1}]`;
    ui.els.addBtn.style.display = t.kind === 'new' ? '' : 'none';
  }

  // Auto-commit: the FIRST param edit made while in NEW mode turns the
  // preview into a real mix layer and switches editing to it in place — ADD
  // TO MIX (ui.addToMix() below) stays as an explicit alternative for anyone
  // who wants to commit without touching a control. A no-op once already
  // committed (editTarget.kind !== 'new'), so every param handler below can
  // call this unconditionally on every edit — including every tick of a
  // drag — without double-committing.
  ui.commitNewOnEdit = function commitNewOnEdit() {
    if (ui.state.editTarget.kind !== 'new') return;
    const effectId = ui.state.editTarget.effect;
    // Commit BY REFERENCE (not a copy): the live param controls captured
    // this exact params object in their closures — moving the same object
    // into the layer lets an in-flight scrub drag keep mutating the layer
    // with no DOM rebuild of the active-params panel (a rebuild mid-drag
    // would drop the pointer capture). ui.addToMix (the button) still copies —
    // it's never mid-drag.
    ui.state.mix.push({ effect: effectId, enabled: true, params: ui.state.editTarget.params });
    ui.state.editTarget = { kind: 'layer', index: ui.state.mix.length - 1 };
    ui.buildMixList(); // show + highlight the new layer
    // Drop the picker's stale "this effect is the NEW preview" highlight —
    // #effect-list is a separate DOM subtree from #active-params (the live
    // drag target), so rebuilding it here is safe mid-drag.
    ui.buildEffectList();
    ui.refreshTargetHeader(); // "NEW · X" -> "EDIT · X [n]", hide ADD TO MIX
  }

  // Commit-then-render: the standard tail of every param-control mutation
  // handler (scrub set / color onChange / select change / text input) —
  // auto-commits a NEW-mode edit into a layer (see commitNewOnEdit above)
  // before requesting the frame that shows it.
  ui.afterParamEdit = function afterParamEdit() {
    ui.commitNewOnEdit();
    ui.requestRender();
  }

  // ---------- rendering ----------
  // Live canvas = the enabled mix (PRE, when non-identity, is already a
  // normal committed layer in there — see reconcilePreLayer), then, in NEW
  // mode, the picked effect on top — exactly the order ui.commitNewOnEdit()/
  // ui.addToMix() commit, so the preview never jumps when a layer is added.
  ui.livePreviewStack = function livePreviewStack() {
    const enabled = ui.state.mix.filter((s) => s.enabled !== false);
    if (ui.state.editTarget.kind === 'new') {
      return enabled.concat([{ effect: ui.state.editTarget.effect, enabled: true, params: ui.state.editTarget.params }]);
    }
    return enabled;
  }

  ui.requestRender = function requestRender() {
    ui.renderDirty = true;
    ui.scheduleHistorySync(); // fires after essentially every doc mutation — see the history module above
  }
  ui.requestOutput = function requestOutput() {
    ui.outputDirty = true;
    ui.renderDirty = true;
    ui.refreshOutputVisuals();
    ui.scheduleHistorySync();
  }

  ui.frame = function frame() {
    if (ui.pipeline && ui.pipeline.hasImage()) {
      if (ui.outputDirty) {
        ui.pipeline.applyOutput(ui.effectiveOutput());
        ui.outputDirty = false;
      }
      if (ui.renderDirty) {
        ui.pipeline.render(ui.livePreviewStack(), ui.state.source);
        ui.renderDirty = false;
      }
      // The processing resolution (canvas backing store) changed.
      if (ui.els.canvas.width !== ui.view.lastW || ui.els.canvas.height !== ui.view.lastH) {
        const oldW = ui.view.lastW;
        const oldH = ui.view.lastH;
        ui.view.lastW = ui.els.canvas.width;
        ui.view.lastH = ui.els.canvas.height;
        if (ui.view.freshImage || !oldW || !oldH) {
          // A brand-new source image (loadImageFile sets freshImage — see
          // there) — fit-to-ui.view, capped at 100% so a small source opens 1:1
          // instead of blown up to fill the viewport.
          ui.view.freshImage = false;
          ui.refitView();
        } else {
          // Same image, buffer resized (e.g. dragging PRE's CANVAS scrub) —
          // snap to 1:1. The user wants the true pixels: at 100% the marks
          // hold their real size while the picture shrinks around them, which
          // IS the effect coarsening relative to the content. (An earlier
          // version compensated zoom to hold the on-screen size constant;
          // 1:1 shows the same fact without lying about the scale.)
          ui.view.zoom = 1;
          ui.centerView();
          ui.applyView();
        }
      }
    }
    requestAnimationFrame(ui.frame);
  }

  ui.showToast = function showToast(message) {
    ui.els.toast.textContent = message;
    ui.els.toast.classList.add('show');
    clearTimeout(ui.showToast._t);
    ui.showToast._t = setTimeout(() => ui.els.toast.classList.remove('show'), 1600);
  }

  // Return to NEW mode on the first visible effect (or the current one).
  ui.goNewMode = function goNewMode() {
    const visible = ui.visibleEffectList();
    const id = visible.length ? visible[0].id : RSTR.EFFECT_LIST[0].id;
    ui.state.editTarget = { kind: 'new', effect: id, params: RSTR.defaultParams(id) };
    ui.buildEditor();
    ui.buildEffectList();
  }
  ui.preLayerRef = null;

})((window.RSTR = window.RSTR || {}));
