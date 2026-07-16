// ui/catalog.js — catalog
(function (RSTR) {
  'use strict';
  const ui = RSTR.ui;

  // ---------- settings view (gear) ----------
  // Scoped to column 1's /Effects section only (not a full-panel takeover):
  // swaps the flat effect-list for the enable/disable checklist. Column 2
  // (PRE/MIX/edit panel/footer) stays visible and usable throughout.
  ui.showSettings = function showSettings(open) {
    ui.state.settingsOpen = open;
    ui.els.settingsBtn.classList.toggle('active', open);
    ui.els.effectList.style.display = open ? 'none' : '';
    ui.els.settingsPanel.style.display = open ? 'block' : 'none';
  }

  ui.buildSettings = function buildSettings() {
    const list = ui.els.settingsList;
    list.innerHTML = '';
    const groupById = {};
    for (const g of ui.state.effectGroups) groupById[g.id] = g;

    const makeRow = (def) => {
      const row = document.createElement('label');
      row.className = 'settings-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !ui.state.disabled.has(def.id);
      cb.addEventListener('change', () => ui.toggleEffect(def.id, cb.checked));
      const name = document.createElement('span');
      name.textContent = def.name;
      row.append(cb, name);
      return row;
    };

    for (const entry of ui.state.effectOrder) {
      if (entry.indexOf('@group:') === 0) {
        const g = groupById[entry.slice(7)];
        if (!g) continue;
        const header = document.createElement('div');
        header.className = 'group-header';
        const name = document.createElement('span');
        name.className = 'group-name';
        name.textContent = g.name;
        header.appendChild(name);
        list.appendChild(header);
        for (const id of g.effects) {
          const def = RSTR.getEffect(id);
          if (!def) continue;
          const row = makeRow(def);
          row.classList.add('grouped');
          list.appendChild(row);
        }
      } else {
        const def = RSTR.getEffect(entry);
        if (!def) continue;
        list.appendChild(makeRow(def));
      }
    }
  }

  ui.toggleEffect = function toggleEffect(id, enabled) {
    if (enabled) ui.state.disabled.delete(id);
    else ui.state.disabled.add(id);
    RSTR.preset.saveDisabledEffects([...ui.state.disabled]);
    // if the NEW-mode effect just got hidden, move to the first visible one
    if (ui.state.editTarget.kind === 'new' && ui.state.disabled.has(ui.state.editTarget.effect)) {
      const visible = ui.visibleEffectList();
      if (visible.length) ui.selectEffect(visible[0].id);
    }
    ui.buildEffectList();
  }

  // ---------- /Effects catalog: order + user groups (persisted) ----------
  // localStorage keys (rstr.* namespace). effectOrder is an array mixing
  // plain effect ids (top-level, ungrouped rows) with group-anchor tokens
  // "@group:<id>"; a group's own members live in effectGroups[i].effects,
  // never duplicated at the top level.
  const LS_ORDER = 'rstr.effectOrder';
  const LS_GROUPS = 'rstr.effectGroups';
  ui.groupSeq = 0;
  ui.makeGroupId = function makeGroupId() {
    return 'g' + Date.now().toString(36) + ui.groupSeq++;
  }

  // Robust load: the effect registry changes between versions, so this must
  // never lose an effect and never crash on garbage storage.
  //  - unknown/stale ids (in order OR inside a group) are dropped
  //  - registry effects missing from storage are appended, ungrouped, at the end
  //  - group tokens with no matching group are dropped; groups missing a
  //    token get one appended at the end
  ui.loadOrderState = function loadOrderState() {
    let order, groups;
    try { order = JSON.parse(localStorage.getItem(LS_ORDER) || '[]'); } catch { order = []; }
    try { groups = JSON.parse(localStorage.getItem(LS_GROUPS) || '[]'); } catch { groups = []; }
    if (!Array.isArray(order)) order = [];
    if (!Array.isArray(groups)) groups = [];

    groups = groups
      .filter((g) => g && typeof g === 'object' && typeof g.name === 'string')
      .map((g) => ({
        id: typeof g.id === 'string' && g.id ? g.id : ui.makeGroupId(),
        name: g.name,
        collapsed: !!g.collapsed,
        effects: Array.isArray(g.effects) ? g.effects.filter((x) => typeof x === 'string') : [],
      }));

    const validIds = RSTR.EFFECT_LIST.filter((d) => !d.internal).map((d) => d.id);
    const validSet = new Set(validIds);

    // drop stale ids from groups; track which ids a group has already claimed
    // (an id can only live in ONE place — first group wins if duplicated)
    const claimed = new Set();
    for (const g of groups) {
      g.effects = g.effects.filter((id) => validSet.has(id) && !claimed.has(id));
      g.effects.forEach((id) => claimed.add(id));
    }
    const groupIdSet = new Set(groups.map((g) => g.id));

    const seenTop = new Set();
    order = order.filter((entry) => {
      if (typeof entry !== 'string') return false;
      if (entry.indexOf('@group:') === 0) {
        const gid = entry.slice(7);
        if (!groupIdSet.has(gid) || seenTop.has(entry)) return false;
        seenTop.add(entry);
        return true;
      }
      if (!validSet.has(entry) || claimed.has(entry) || seenTop.has(entry)) return false;
      seenTop.add(entry);
      return true;
    });

    for (const g of groups) {
      const token = '@group:' + g.id;
      if (!seenTop.has(token)) {
        order.push(token);
        seenTop.add(token);
      }
    }
    for (const id of validIds) {
      if (!claimed.has(id) && !seenTop.has(id)) {
        order.push(id);
        seenTop.add(id);
      }
    }

    return { order, groups };
  }

  ui.saveOrderState = function saveOrderState() {
    try {
      localStorage.setItem(LS_ORDER, JSON.stringify(ui.state.effectOrder));
      localStorage.setItem(LS_GROUPS, JSON.stringify(ui.state.effectGroups));
    } catch {
      /* non-fatal */
    }
  }

  ui.removeEffectFromCurrentLocation = function removeEffectFromCurrentLocation(id) {
    const idx = ui.state.effectOrder.indexOf(id);
    if (idx >= 0) ui.state.effectOrder.splice(idx, 1);
    for (const g of ui.state.effectGroups) {
      const gi = g.effects.indexOf(id);
      if (gi >= 0) {
        g.effects.splice(gi, 1);
        break;
      }
    }
  }

  // Move `id` to the top level (ungrouped), inserted relative to `targetId`
  // (another top-level id or a group token) — before or after it.
  ui.moveEffectToTopLevel = function moveEffectToTopLevel(id, targetId, before) {
    ui.removeEffectFromCurrentLocation(id);
    let idx = ui.state.effectOrder.indexOf(targetId);
    if (idx < 0) idx = ui.state.effectOrder.length;
    ui.state.effectOrder.splice(before ? idx : idx + 1, 0, id);
  }

  // Move `id` into group `gid`. targetId null = append to the end of the
  // group; otherwise insert relative to that member (before/after).
  ui.moveEffectIntoGroup = function moveEffectIntoGroup(id, gid, targetId, before) {
    ui.removeEffectFromCurrentLocation(id);
    const g = ui.state.effectGroups.find((x) => x.id === gid);
    if (!g) return;
    if (targetId == null) {
      g.effects.push(id);
      return;
    }
    let idx = g.effects.indexOf(targetId);
    if (idx < 0) idx = g.effects.length;
    g.effects.splice(before ? idx : idx + 1, 0, id);
  }

  // Move a whole group's anchor token to a new position among the top-level
  // effectOrder entries (other groups' tokens + ungrouped effect ids),
  // inserted relative to `targetEntry` (a raw effectOrder entry — a plain
  // effect id or another group's "@group:<id>" token). Groups only ever live
  // at the top level, so this never touches any group's `effects` array —
  // there is no nesting path here.
  ui.moveGroupToTopLevel = function moveGroupToTopLevel(gid, targetEntry, before) {
    const token = '@group:' + gid;
    const idx = ui.state.effectOrder.indexOf(token);
    if (idx >= 0) ui.state.effectOrder.splice(idx, 1);
    let targetIdx = ui.state.effectOrder.indexOf(targetEntry);
    if (targetIdx < 0) targetIdx = ui.state.effectOrder.length;
    ui.state.effectOrder.splice(before ? targetIdx : targetIdx + 1, 0, token);
  }

  ui.createGroupFlow = function createGroupFlow() {
    ui.openInline('New group name…', '', (text) => {
      const name = String(text).trim();
      if (!name) return 'Enter a name';
      const g = { id: ui.makeGroupId(), name, collapsed: false, effects: [] };
      ui.state.effectGroups.push(g);
      ui.state.effectOrder.push('@group:' + g.id);
      ui.saveOrderState();
      ui.buildEffectList();
      ui.buildSettings();
      return null;
    });
  }

  ui.renameGroupFlow = function renameGroupFlow(gid) {
    const g = ui.state.effectGroups.find((x) => x.id === gid);
    if (!g) return;
    ui.openInline('Group name…', g.name, (text) => {
      const name = String(text).trim();
      if (!name) return 'Enter a name';
      g.name = name;
      ui.saveOrderState();
      ui.buildEffectList();
      ui.buildSettings();
      return null;
    });
  }

  // Deleting a group ungroups its effects (they return to the top level, at
  // the group's old position) — it never deletes the effects themselves.
  ui.deleteGroup = function deleteGroup(gid) {
    const idx = ui.state.effectGroups.findIndex((g) => g.id === gid);
    if (idx < 0) return;
    const g = ui.state.effectGroups[idx];
    const token = '@group:' + gid;
    const orderIdx = ui.state.effectOrder.indexOf(token);
    ui.state.effectGroups.splice(idx, 1);
    if (orderIdx >= 0) ui.state.effectOrder.splice(orderIdx, 1, ...g.effects);
    else ui.state.effectOrder.push(...g.effects);
    ui.saveOrderState();
    ui.buildEffectList();
    ui.buildSettings();
    ui.showToast(`Deleted group "${g.name}"`);
  }

  // ---------- drag-to-reorder (native HTML5 DnD, no library) ----------
  // ui.dragItem = { type: 'effect'|'group', id } for whatever is currently being
  // dragged; a 1px insertion line (top/bottom border color swap — see
  // .drop-before/.drop-after in CSS, shared by .effect-row AND .group-header)
  // marks where it will land; a group header additionally highlights
  // (.drop-into) when an EFFECT drop would join that group instead of
  // inserting a sibling row. Groups themselves never have a "join" target —
  // dragging a group only ever reorders it as a top-level sibling, so groups
  // can't nest inside groups.
  ui.dragItem = null;

  ui.clearDropIndicators = function clearDropIndicators() {
    const scope = ui.els.effectList;
    if (!scope) return;
    scope.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((el) => {
      el.classList.remove('drop-before', 'drop-after', 'drop-into');
    });
  }

  ui.wireEffectDrag = function wireEffectDrag(row, id) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      ui.dragItem = { type: 'effect', id };
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', id);
      } catch {
        /* non-fatal — some embedders restrict dataTransfer */
      }
    });
    row.addEventListener('dragend', () => {
      ui.dragItem = null;
      ui.clearDropIndicators();
    });
  }

  // Whole-group drag: dragstart on the header carries the group id. Same
  // mechanism as wireEffectDrag, distinguished by ui.dragItem.type so drop
  // targets can tell a dragged group apart from a dragged effect.
  ui.wireGroupDrag = function wireGroupDrag(header, gid) {
    header.draggable = true;
    header.addEventListener('dragstart', (e) => {
      ui.dragItem = { type: 'group', id: gid };
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', '@group:' + gid);
      } catch {
        /* non-fatal — some embedders restrict dataTransfer */
      }
    });
    header.addEventListener('dragend', () => {
      ui.dragItem = null;
      ui.clearDropIndicators();
    });
  }

  // `el` is a row/header acting as a before/after sibling-insertion drop
  // target. `onDropEffect(draggedEffectId, before)` / `onDropGroup(draggedGroupId,
  // before)` perform the actual reorder — pass null for either to reject that
  // drag type on this target entirely (no indicator shown, no drop). `before`
  // is computed from pointer Y vs the target's vertical midpoint.
  ui.wireDropTarget = function wireDropTarget(el, onDropEffect, onDropGroup) {
    el.addEventListener('dragover', (e) => {
      if (!ui.dragItem) return;
      const cb = ui.dragItem.type === 'effect' ? onDropEffect : ui.dragItem.type === 'group' ? onDropGroup : null;
      if (!cb) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      ui.clearDropIndicators();
      el.classList.add(before ? 'drop-before' : 'drop-after');
    });
    el.addEventListener('drop', (e) => {
      if (!ui.dragItem) return;
      const cb = ui.dragItem.type === 'effect' ? onDropEffect : ui.dragItem.type === 'group' ? onDropGroup : null;
      if (!cb) return;
      e.preventDefault();
      const before = el.classList.contains('drop-before');
      const id = ui.dragItem.id;
      ui.clearDropIndicators();
      ui.dragItem = null;
      cb(id, before);
    });
  }

  // Group headers are also a drop target for "drop straight onto me" (join
  // the group, appended at the end) — distinct from before/after which
  // reorders it as a top-level sibling of the header itself. Effect drags
  // only — a dragged GROUP never joins another group (no nesting).
  ui.wireGroupDropTarget = function wireGroupDropTarget(header, gid) {
    header.addEventListener('dragover', (e) => {
      if (!ui.dragItem || ui.dragItem.type !== 'effect') return;
      e.preventDefault();
      ui.clearDropIndicators();
      header.classList.add('drop-into');
    });
    header.addEventListener('drop', (e) => {
      if (!ui.dragItem || ui.dragItem.type !== 'effect') return;
      e.preventDefault();
      const id = ui.dragItem.id;
      ui.clearDropIndicators();
      ui.dragItem = null;
      ui.moveEffectIntoGroup(id, gid, null, true);
      ui.saveOrderState();
      ui.buildEffectList();
      ui.buildSettings();
    });
  }

  // ---------- /Effects picker (drag-reorderable, groupable) ----------
  ui.buildEffectList = function buildEffectList() {
    const list = ui.els.effectList;
    list.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'group-grid';
    const activeNew = ui.state.editTarget.kind === 'new' ? ui.state.editTarget.effect : null;
    const groupById = {};
    for (const g of ui.state.effectGroups) groupById[g.id] = g;
    let renderedAny = false;

    const makeEffectRow = (def, groupId) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'effect-row' + (def.id === activeNew ? ' active' : '') + (groupId ? ' grouped' : '');
      row.textContent = def.name;
      row.addEventListener('click', () => ui.selectEffect(def.id));
      ui.wireEffectDrag(row, def.id);
      ui.wireDropTarget(
        row,
        (draggedId, before) => {
          if (draggedId === def.id) return;
          if (groupId) ui.moveEffectIntoGroup(draggedId, groupId, def.id, before);
          else ui.moveEffectToTopLevel(draggedId, def.id, before);
          ui.saveOrderState();
          ui.buildEffectList();
          ui.buildSettings();
        },
        // A dragged GROUP may only land among top-level (ungrouped) rows —
        // never between two members of a group, which would be nesting.
        groupId
          ? null
          : (draggedGid, before) => {
              ui.moveGroupToTopLevel(draggedGid, def.id, before);
              ui.saveOrderState();
              ui.buildEffectList();
              ui.buildSettings();
            }
      );
      return row;
    };

    for (const entry of ui.state.effectOrder) {
      if (entry.indexOf('@group:') === 0) {
        const g = groupById[entry.slice(7)];
        if (!g) continue;
        const header = document.createElement('div');
        header.className = 'group-header';
        const arrow = document.createElement('span');
        arrow.className = 'group-arrow';
        arrow.textContent = g.collapsed ? '▸' : '▾';
        const name = document.createElement('span');
        name.className = 'group-name';
        name.textContent = g.name;
        name.title = 'Double-click to rename';
        name.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          ui.renameGroupFlow(g.id);
        });
        const del = ui.iconButton('✕', 'Delete group (keeps effects, ungrouped)', () => ui.deleteGroup(g.id));
        del.classList.add('icon-btn-sm');
        header.append(arrow, name, del);
        header.addEventListener('click', (e) => {
          if (e.target === del) return;
          g.collapsed = !g.collapsed;
          ui.saveOrderState();
          ui.buildEffectList();
          ui.buildSettings();
        });
        // Group headers accept two distinct drags: an EFFECT dropped onto
        // the header joins the group (wireGroupDropTarget, .drop-into); a
        // whole GROUP dropped onto the header reorders it as a top-level
        // sibling, before/after (wireDropTarget, .drop-before/.drop-after) —
        // never a "join", so groups can't nest.
        ui.wireGroupDrag(header, g.id);
        ui.wireGroupDropTarget(header, g.id);
        ui.wireDropTarget(header, null, (draggedGid, before) => {
          if (draggedGid === g.id) return;
          ui.moveGroupToTopLevel(draggedGid, '@group:' + g.id, before);
          ui.saveOrderState();
          ui.buildEffectList();
          ui.buildSettings();
        });
        grid.appendChild(header);
        renderedAny = true;
        if (!g.collapsed) {
          for (const id of g.effects) {
            const def = RSTR.getEffect(id);
            if (!def || ui.state.disabled.has(id)) continue;
            grid.appendChild(makeEffectRow(def, g.id));
            renderedAny = true;
          }
        }
      } else {
        const def = RSTR.getEffect(entry);
        if (!def || ui.state.disabled.has(entry)) continue;
        grid.appendChild(makeEffectRow(def, null));
        renderedAny = true;
      }
    }

    if (!renderedAny) {
      const empty = document.createElement('div');
      empty.className = 'stack-empty';
      empty.textContent = 'All effects hidden — enable some in ⚙ Settings.';
      list.appendChild(empty);
      return;
    }
    list.appendChild(grid);
  }

  // ---------- target selection ----------
  ui.selectEffect = function selectEffect(id) {
    // NEW mode — a fresh effect previewed on top of the mix
    ui.state.editTarget = { kind: 'new', effect: id, params: RSTR.defaultParams(id) };
    ui.buildEditor();
    ui.buildEffectList();
    ui.buildMixList();
    ui.requestRender();
  }

  ui.selectLayer = function selectLayer(index) {
    ui.state.editTarget = { kind: 'layer', index };
    ui.buildEditor();
    ui.buildEffectList();
    ui.buildMixList();
    ui.requestRender();
  }

  ui.selectOutput = function selectOutput() {
    ui.state.editTarget = { kind: 'output' };
    ui.buildEditor();
    ui.buildEffectList();
    ui.buildMixList();
    ui.requestOutput();
  }
})((window.RSTR = window.RSTR || {}));
