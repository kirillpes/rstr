// ui/boot.js — boot
(function (RSTR) {
  'use strict';
  const ui = RSTR.ui;

  // ---------- boot ----------
  ui.boot = function boot() {
    ui.els = {
      panel: document.getElementById('panel'),
      canvas: document.getElementById('gl-canvas'),
      canvasTransform: document.getElementById('canvas-transform'),
      dropzone: document.getElementById('dropzone'),
      canvasWrap: document.getElementById('canvas-wrap'),
      newImageBtn: document.getElementById('new-image-btn'),
      viewportControls: document.getElementById('viewport-controls'),
      zoomSlider: document.getElementById('zoom-slider'),
      zoomReadout: document.getElementById('zoom-readout'),
      zoomFit: document.getElementById('zoom-fit-btn'),
      zoom100: document.getElementById('zoom-100-btn'),
      cropGuide: document.getElementById('crop-guide'),
      cropGuideAnchor: document.getElementById('crop-guide-anchor'),
      settingsBtn: document.getElementById('settings-btn'),
      settingsPanel: document.getElementById('settings-panel'),
      settingsList: document.getElementById('settings-list'),
      effectList: document.getElementById('effect-list'),
      preSection: document.getElementById('pre-section'),
      targetHeader: document.getElementById('target-header'),
      effectEditor: document.getElementById('effect-editor'),
      editorActions: document.getElementById('editor-actions'),
      outputEditor: document.getElementById('output-editor'),
      activeParams: document.getElementById('active-params'),
      presetsBtn: document.getElementById('presets-btn'),
      settingsResetBtn: document.getElementById('settings-reset-btn'),
      presetsBackdrop: document.getElementById('presets-backdrop'),
      presetsModal: document.getElementById('presets-modal'),
      presetsModalTitle: document.getElementById('presets-modal-title'),
      presetsList: document.getElementById('presets-list'),
      presetsCloseBtn: document.getElementById('presets-close-btn'),
      presetsSaveBtn: document.getElementById('presets-save-btn'),
      addGroupBtn: document.getElementById('add-group-btn'),
      addBtn: document.getElementById('add-btn'),
      mixList: document.getElementById('mix-list'),
      ratioSelect: document.getElementById('crop-ratio'),
      cropCustomRow: document.getElementById('crop-custom-row'),
      cropW: document.getElementById('crop-w'),
      cropH: document.getElementById('crop-h'),
      alignPicker: document.getElementById('align-picker'),
      scaleModeSelect: document.getElementById('scale-mode'),
      scaleSizeRow: document.getElementById('scale-size-row'),
      scaleSize: document.getElementById('scale-size'),
      scaleExactRow: document.getElementById('scale-exact-row'),
      scaleW: document.getElementById('scale-w'),
      scaleH: document.getElementById('scale-h'),
      formatSelect: document.getElementById('format-select'),
      qualityRow: document.getElementById('quality-row'),
      qualityInput: document.getElementById('quality-input'),
      qualityValue: document.getElementById('quality-value'),
      dimsReadout: document.getElementById('dims-readout'),
      styleSelect: document.getElementById('style-select'),
      styleSave: document.getElementById('style-save-btn'),
      styleDel: document.getElementById('style-del-btn'),
      exportPresetsBtn: document.getElementById('export-presets-btn'),
      backupToggleBtn: document.getElementById('backup-toggle-btn'),
      backupRow: document.getElementById('backup-row'),
      libraryExportBtn: document.getElementById('library-export-btn'),
      libraryImportBtn: document.getElementById('library-import-btn'),
      libraryImportInput: document.getElementById('library-import-input'),
      inlineInput: document.getElementById('inline-input'),
      inlineField: document.getElementById('inline-field'),
      inlineApply: document.getElementById('inline-apply'),
      inlineCancel: document.getElementById('inline-cancel'),
      inlineError: document.getElementById('inline-error'),
      fileInput: document.getElementById('file-input'),
      toast: document.getElementById('toast'),
    };

    ui.pipeline = new RSTR.Pipeline(ui.els.canvas);

    // restore hidden-effects setting; keep the NEW-mode effect visible
    ui.state.disabled = new Set(RSTR.preset.loadDisabledEffects());
    if (ui.state.disabled.has(ui.state.editTarget.effect)) {
      const visible = ui.visibleEffectList();
      if (visible.length) ui.state.editTarget = { kind: 'new', effect: visible[0].id, params: RSTR.defaultParams(visible[0].id) };
    }

    // restore the user's /Effects catalog order + groups (robust to the
    // registry changing between versions — see ui.loadOrderState())
    const orderState = ui.loadOrderState();
    ui.state.effectOrder = orderState.order;
    ui.state.effectGroups = orderState.groups;

    ui.buildEffectList();
    ui.buildEditor();
    ui.buildMixList();
    ui.buildSettings();
    ui.buildPreSection();
    ui.buildStyleSelect();
    ui.wireOutputTab();
    ui.wireViewport();
    ui.showSettings(false);
    ui.refreshOutputVisuals();

    // gear (top-right of the canvas) toggles the settings checklist in
    // column 1's /Effects section (see showSettings)
    ui.els.settingsBtn.addEventListener('click', () => ui.showSettings(!ui.state.settingsOpen));

    // per-effect settings: RESET, PRESETS modal, ADD, create-group
    ui.els.settingsResetBtn.addEventListener('click', ui.resetCurrentEffectParams);
    ui.els.presetsBtn.addEventListener('click', ui.openPresetsModal);
    ui.els.presetsCloseBtn.addEventListener('click', ui.closePresetsModal);
    ui.els.presetsBackdrop.addEventListener('click', ui.closePresetsModal);
    ui.els.presetsSaveBtn.addEventListener('click', ui.saveCurrentPresetFlow);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && ui.els.presetsModal.style.display !== 'none') ui.closePresetsModal();
    });
    ui.els.addGroupBtn.addEventListener('click', ui.createGroupFlow);
    ui.els.addBtn.addEventListener('click', ui.addToMix);

    // global actions
    document.getElementById('export-btn').addEventListener('click', ui.exportImage);
    document.getElementById('reset-btn').addEventListener('click', ui.resetStyle);

    // style library + code import/export
    ui.els.styleSelect.addEventListener('change', ui.loadSelectedStyle);
    ui.els.styleSave.addEventListener('click', ui.saveStyleFlow);
    ui.els.styleDel.addEventListener('click', ui.deleteSelectedStyle);
    document.getElementById('copy-btn').addEventListener('click', ui.copyStyleCode);
    ui.els.exportPresetsBtn.addEventListener('click', ui.exportStyleToPresets);
    ui.els.backupToggleBtn.addEventListener('click', ui.toggleBackupRow);
    ui.els.libraryExportBtn.addEventListener('click', ui.exportAllStyles);
    ui.els.libraryImportBtn.addEventListener('click', () => ui.els.libraryImportInput.click());
    ui.els.libraryImportInput.addEventListener('change', () => {
      const f = ui.els.libraryImportInput.files[0];
      if (f) ui.importLibraryFile(f);
      ui.els.libraryImportInput.value = ''; // allow re-picking the same filename later
    });
    ui.els.inlineApply.addEventListener('click', ui.applyInline);
    ui.els.inlineCancel.addEventListener('click', ui.closeInline);

    // image file input
    ui.els.fileInput.addEventListener('change', () => {
      if (ui.els.fileInput.files[0]) ui.loadImageFile(ui.els.fileInput.files[0]);
    });

    // NEW IMAGE / ✕ — drop the current image, back to the drop zone
    ui.els.newImageBtn.addEventListener('click', ui.clearImage);
    ui.els.dropzone.addEventListener('click', () => ui.els.fileInput.click());

    // drag-drop over the whole canvas area, any time (replace current)
    ui.els.canvasWrap.addEventListener('dragover', (e) => {
      e.preventDefault();
      ui.els.dropzone.classList.add('drag-over');
    });
    ui.els.canvasWrap.addEventListener('dragleave', (e) => {
      if (e.target === ui.els.canvasWrap || e.target === ui.els.dropzone) ui.els.dropzone.classList.remove('drag-over');
    });
    ui.els.canvasWrap.addEventListener('drop', (e) => {
      e.preventDefault();
      ui.els.dropzone.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) ui.loadImageFile(e.dataTransfer.files[0]);
    });

    // global Ctrl+V — image/style-aware paste anywhere except editable fields
    document.addEventListener('paste', ui.handleGlobalPaste);

    // global undo/redo — Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y as a redo alias. Same
    // isEditableTarget guard handleGlobalPaste uses above, so Ctrl+Z inside
    // the scrub click-to-type field, the color picker's hex field, ascii's
    // character-set field, etc. does the browser's own native text undo
    // instead of jumping the whole document.
    document.addEventListener('keydown', (e) => {
      if (ui.isEditableTarget(e.target)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        ui.historyUndo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        ui.historyRedo();
      }
    });

    // patterns reads ImageData decoded async by assets.js — re-render
    // once decode lands, in case it rendered as passthrough first.
    if (RSTR.assetsReady) RSTR.assetsReady.then(ui.requestRender);

    // Establish the undo baseline now that boot's initial wiring (and any
    // default style/image setup) is done — histPresent starts at THIS ui.state,
    // so the first real edit has something to undo back to.
    ui.commitHistoryIfChanged();

    requestAnimationFrame(ui.frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ui.boot);
  } else {
    ui.boot();
  }
})((window.RSTR = window.RSTR || {}));
