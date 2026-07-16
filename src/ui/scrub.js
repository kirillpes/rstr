// ui/scrub.js — scrub
(function (RSTR) {
  'use strict';
  const ui = RSTR.ui;

  // ---------- scrub bar (shared range control) ----------
  // Full-width horizontal bar: click/drag anywhere = absolute value (pointer
  // capture), wheel = ±step, dblclick = reset. One mechanism for both the PRE
  // block and every effect `range` param (replaced the PRE rotary knobs and
  // the native <input type=range> rows).
  // opts: { label, min, max, step, get, set, format?, reset, snap?, editable? }
  // get() may return null ("value not expressible" — fill pins to 100%, the
  // format() text carries the story); el.sync() repaints from get().
  // snap (opt-in, e.g. 100): MAGNETIC, not rounding — dragging tracks the
  // cursor at full `step` resolution (every intermediate value, e.g. 1234,
  // stays reachable), but a value that lands within SCRUB_MAGNET_TOLERANCE of
  // a multiple of `snap` sticks to that multiple. Wheel/dblclick ignore
  // `snap` entirely (still plain opts.step / opts.reset).
  // editable: click-to-type is the DEFAULT for every scrub (opt OUT with
  // `editable: false`) — click the value readout to swap in a text <input>;
  // Enter/blur commits the typed number, CLAMPED to [min,max] and rounded to
  // the param's own precision (derived from `step`), but NEVER snapped/
  // magnetised (typing is for exact values). Esc cancels. No native prompt().
  // Shift, held while dragging or wheeling, quantizes to 10x `step` — on a
  // `snap` scrub this OVERRIDES the magnet (coarse-and-predictable beats
  // "sticks to the wrong spot").
  const SCRUB_MAGNET_TOLERANCE = 8; // value-units; tuned so e.g. 1234 (34 away
  // from 1200) stays reachable while landing within 8 of a multiple of `snap` sticks.

  ui.makeScrub = function makeScrub(opts) {
    const el = document.createElement('div');
    el.className = 'scrub';
    const fill = document.createElement('div');
    fill.className = 'scrub-fill';
    const lab = document.createElement('span');
    lab.className = 'scrub-label';
    lab.textContent = opts.label;
    const val = document.createElement('span');
    val.className = 'scrub-value';
    el.append(fill, lab, val);

    // Decimal precision implied by `step` (same 3-tier rule renderParamControl
    // uses for display) — governs how a TYPED value is rounded: an integer
    // (step >= 1) param can't end up storing "1.5", a step:0.01 param can.
    function stepDecimals() {
      const step = opts.step || 1;
      if (step >= 1) return 0;
      if (step >= 0.1) return 1;
      return 2;
    }
    function roundTo(v, decimals) {
      const f = Math.pow(10, decimals);
      return Math.round(v * f) / f;
    }
    function quantizeTo(v, stepSize) {
      const steps = Math.round((v - opts.min) / stepSize);
      const q = Math.min(opts.max, Math.max(opts.min, opts.min + steps * stepSize));
      return Math.round(q * 1000) / 1000;
    }
    function quantize(v) {
      return quantizeTo(v, opts.step);
    }
    function clamp(v) {
      return Math.min(opts.max, Math.max(opts.min, v));
    }
    // Magnetic snap: a step-quantized value that lands within tolerance of a
    // multiple of `snap` sticks to it; otherwise passes through untouched —
    // so every step-resolution value in between stays reachable by dragging.
    function magnetize(q) {
      const nearest = clamp(Math.round(q / opts.snap) * opts.snap);
      return Math.abs(q - nearest) <= SCRUB_MAGNET_TOLERANCE ? nearest : q;
    }
    let editing = false;
    let input = null;
    function cancelEditDom() {
      // Tear down the in-progress edit <input> WITHOUT recursing into sync()
      // — sync() itself calls this when state changes out from under an
      // open edit (e.g. a Reset button elsewhere).
      if (!editing) return;
      editing = false;
      if (input) input.remove();
      input = null;
      val.style.display = '';
    }
    function sync() {
      cancelEditDom();
      const v = opts.get();
      const t = v == null ? 1 : (v - opts.min) / (opts.max - opts.min);
      fill.style.width = Math.min(100, Math.max(0, t * 100)) + '%';
      val.textContent = opts.format ? opts.format(v) : String(v);
    }
    // Raw (unquantized) cursor position — the fill's smooth drag position;
    // the committed value is derived from it separately (committedValue).
    function rawFromEvent(e) {
      const rect = el.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      return opts.min + t * (opts.max - opts.min);
    }
    // The value actually committed for a drag/wheel tick: Shift always wins
    // (coarse 10x-step quantize, overriding any magnet); otherwise a `snap`
    // scrub magnetizes; otherwise plain step quantize.
    function committedValue(raw, shift) {
      if (shift) return quantizeTo(raw, opts.step * 10);
      const q = quantize(raw);
      return opts.snap ? magnetize(q) : q;
    }

    let dragId = null;
    let lastApplied = null;
    // Click-vs-drag on `.scrub-value`: a pointerdown that lands there no
    // longer stops propagation or short-circuits straight into the editor —
    // it arms a normal drag exactly like anywhere else on the bar (pointer
    // capture, dragId, listening for move). The one difference: while the
    // down started ON the readout, the FIRST commit is held back until the
    // pointer actually moves past CLICK_TOLERANCE px, so a plain click never
    // nudges the value out from under the user before the type-in editor
    // opens (Esc would otherwise "cancel" onto a value that already moved).
    // The instant real movement is seen, it graduates to an ordinary drag —
    // same position-to-value mapping as the rest of the bar from then on.
    // A pointerdown that starts elsewhere on the bar is untouched: it still
    // commits immediately, same as always.
    // (Previously the readout stopped propagation on its OWN pointerdown so
    // `el`'s drag handler never saw the event and a drag could never start
    // there — that made the rightmost ~25% of every scrub's range, where the
    // readout sits, unreachable by dragging.)
    const CLICK_TOLERANCE = 3; // px
    let pendingValueClick = false; // down started on .scrub-value, still within click tolerance
    let downX = 0;
    let downY = 0;
    function applyDrag(e) {
      const raw = rawFromEvent(e);
      const v = committedValue(raw, e.shiftKey);
      if (v !== lastApplied) {
        lastApplied = v;
        opts.set(v);
      }
      // The fill glides at full (raw) resolution only while magnetizing
      // (snap active, no Shift) so the pull toward a magnet is visible;
      // every other mode (plain step, Shift-coarse) shows the fill at the
      // committed value, same as any other scrub.
      const fillVal = opts.snap && !e.shiftKey ? raw : v;
      const t = (fillVal - opts.min) / (opts.max - opts.min);
      fill.style.width = Math.min(100, Math.max(0, t * 100)) + '%';
      val.textContent = opts.format ? opts.format(v) : String(v);
    }
    el.addEventListener('pointerdown', (e) => {
      if (editing) return; // let the edit <input> handle its own clicks
      el.setPointerCapture(e.pointerId);
      dragId = e.pointerId;
      lastApplied = null;
      downX = e.clientX;
      downY = e.clientY;
      if (opts.editable !== false && e.target === val) {
        pendingValueClick = true; // hold off committing until we know it's a drag, not a click
      } else {
        pendingValueClick = false;
        applyDrag(e);
      }
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (dragId !== e.pointerId) return;
      if (pendingValueClick) {
        const moved = Math.abs(e.clientX - downX) > CLICK_TOLERANCE || Math.abs(e.clientY - downY) > CLICK_TOLERANCE;
        if (!moved) return; // still could be a click — don't touch the value yet
        pendingValueClick = false; // graduated to a real drag
      }
      applyDrag(e);
    });
    function settleDrag(e) {
      if (dragId !== e.pointerId) return false;
      dragId = null;
      sync(); // settle the fill exactly onto the committed value
      return true;
    }
    el.addEventListener('pointerup', (e) => {
      const wasPendingValueClick = pendingValueClick;
      pendingValueClick = false;
      if (settleDrag(e) && wasPendingValueClick) startEdit(); // released before it ever became a drag: a real click
    });
    el.addEventListener('pointercancel', (e) => {
      pendingValueClick = false;
      settleDrag(e);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        if (editing) return;
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        const stepSize = e.shiftKey ? opts.step * 10 : opts.step;
        const cur = opts.get();
        opts.set(quantizeTo((cur == null ? opts.min : cur) + dir * stepSize, stepSize));
        sync();
      },
      { passive: false }
    );
    el.addEventListener('dblclick', () => {
      if (editing) return;
      opts.set(opts.reset);
      sync();
    });

    // ---- click-to-type readout (default for every scrub; opt out with editable:false) ----
    function endEdit(commit) {
      if (!editing) return;
      const raw = commit ? Number(input.value) : NaN;
      cancelEditDom();
      if (commit && !Number.isNaN(raw)) opts.set(clamp(roundTo(raw, stepDecimals()))); // typed: clamp + round to precision, never snap
      sync();
    }
    // Opens the type-in editor. Invoked from the shared pointerup handler
    // above (a no-movement release that started on `.scrub-value`) instead
    // of a `click` listener — that's what lets a drag starting on the
    // readout win whenever the pointer actually moves.
    function startEdit() {
      if (editing) return;
      editing = true;
      val.style.display = 'none';
      input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.className = 'scrub-edit-input';
      const cur = opts.get();
      input.value = cur == null ? '' : String(roundTo(cur, stepDecimals()));
      el.appendChild(input);
      input.focus();
      input.select();
      input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      input.addEventListener('wheel', (ev) => ev.stopPropagation());
      input.addEventListener('dblclick', (ev) => ev.stopPropagation());
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') {
          ev.preventDefault();
          endEdit(true);
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          endEdit(false);
        }
      });
      input.addEventListener('blur', () => endEdit(true));
    }
    if (opts.editable !== false) {
      // .scrub-value is `pointer-events: none` by default (CSS, shared by
      // every scrub) so clicks/drags pass through to the bar underneath —
      // opt back in ONLY here, scoped to this instance via inline style, so
      // this element hit-tests as the drag/click origin (`e.target === val`
      // above) and shows a text cursor. It no longer owns its own
      // pointerdown/click handlers.
      val.style.pointerEvents = 'auto';
      val.style.cursor = 'text';
    }

    el.sync = sync;
    sync();
    return el;
  }
})((window.RSTR = window.RSTR || {}));
