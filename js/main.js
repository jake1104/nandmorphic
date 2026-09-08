// Main entry point: wires engine, renderer, interactor, and UI.

import { Engine, sameCircuitStructure } from './engine.js';
import { draw } from './renderer.js';
import { Interactor } from './interact.js';
import { NodeKind } from './model.js';
import { buildDefinitionFromCircuit } from './encapsulate.js';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const libraryEl = document.getElementById('library-list');
const modalRoot = document.getElementById('modal-root');
const hintEl = document.getElementById('hint');

const engine = new Engine();
const view = { x: 0, y: 0, zoom: 1 };

let interactor;

function resize() {
  const wrap = document.getElementById('canvas-wrap');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  canvas.style.width = wrap.clientWidth + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // now drawing is in CSS pixels; adjust draw to use ctx.canvas sizes in css px
  render();
}

function render() {
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  draw(ctx, engine, view, interactor ? interactor.selection : new Set(), interactor ? interactor.hover : null);
  if (interactor) interactor.drawOverlay(ctx, view);
}

function setStatus(msg) { statusEl.textContent = msg; }

function initInteractor() {
  interactor = new Interactor(engine, canvas, view, {
    onSelectionChange: () => updateToolbar(),
    onStatus: setStatus,
    onOpenNode: openCustomNode,
    onInspectNode: inspectNode,
  });
  canvas.addEventListener('pointerdown', (e) => interactor.onPointerDown(e));
  canvas.addEventListener('pointermove', (e) => interactor.onPointerMove(e));
  canvas.addEventListener('pointerup', (e) => interactor.onPointerUp(e));
  canvas.addEventListener('dblclick', (e) => interactor.onDoubleClick(e));
  window.addEventListener('pointerup', (e) => { if (interactor) interactor.onPointerUp(e); });
}

// ---- Zoom / Pan ----
function zoomAt(sx, sy, factor) {
  const wx = sx / view.zoom + view.x;
  const wy = sy / view.zoom + view.y;
  view.zoom = Math.max(0.1, Math.min(5, view.zoom * factor));
  view.x = wx - sx / view.zoom;
  view.y = wy - sy / view.zoom;
  render();
}

function zoomIn() {
  const wrap = document.getElementById('canvas-wrap');
  zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, 1.25);
}

function zoomOut() {
  const wrap = document.getElementById('canvas-wrap');
  zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, 0.8);
}

function fitAll() {
  const nodes = engine.getNodes();
  if (nodes.length === 0) { view.x = 0; view.y = 0; view.zoom = 1; render(); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - 60);
    minY = Math.min(minY, n.y - 40);
    maxX = Math.max(maxX, n.x + 60);
    maxY = Math.max(maxY, n.y + 40);
  }
  const wrap = document.getElementById('canvas-wrap');
  const cw = wrap.clientWidth;
  const ch = wrap.clientHeight;
  const gw = maxX - minX;
  const gh = maxY - minY;
  const padding = 60;
  view.zoom = Math.min(2, Math.min((cw - padding * 2) / gw, (ch - padding * 2) / gh));
  view.zoom = Math.max(0.1, view.zoom);
  view.x = (minX + maxX) / 2 - cw / (2 * view.zoom);
  view.y = (minY + maxY) / 2 - ch / (2 * view.zoom);
  render();
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  zoomAt(sx, sy, factor);
}, { passive: false });

canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

function addNode(kind) {
  const cw = canvas.clientWidth || 600;
  const ch = canvas.clientHeight || 400;
  const cx = cw / 2 / view.zoom + view.x + (Math.random() * 40 - 20);
  const cy = ch / 2 / view.zoom + view.y + (Math.random() * 40 - 20);
  engine.addNode(kind, cx, cy);
  setStatus(`added ${kind}`);
  render();
}

function encapsulateSelection() {
  if (!interactor || interactor.selection.size === 0) {
    setStatus('select nodes to encapsulate');
    return;
  }
  const sel = Array.from(interactor.selection);
  const circuit = buildDefinitionFromCircuit(engine, sel);
  const ports = circuit.ports || { inputs: [], outputs: [] };
  showNameModal('Name this custom node', 'gate', (name) => {
    const def = engine.registerDefinition(circuit, name);
    // remove the original nodes and drop an instance in their place
    const nodes = engine.getNodes().filter((n) => sel.includes(n.id));
    const cx = nodes.reduce((s, n) => s + n.x, 0) / Math.max(1, nodes.length);
    const cy = nodes.reduce((s, n) => s + n.y, 0) / Math.max(1, nodes.length);
    sel.forEach((id) => engine.removeNode(id));
    engine.instantiate(def, cx, cy);
    interactor.selection.clear();
    updateToolbar();
    renderLibrary();
    setStatus(`encapsulated as '${name}'`);
    render();
  });
}

function openCustomNode(node) {
  down(node);
}

// Hierarchical levels rendered as a browser-style tab strip. `levels` is a
// stack (path): index 0 is always the root; each deeper level is a custom
// node whose internals are being edited. Every level stores the parent's
// snapshot so we can navigate back, and (like browser tabs) clicking any tab
// in the strip collapses down to that level.
const levels = [];
let activeLevel = 0;

function levelTitle(i) {
  if (i === 0) return 'Root';
  const f = levels[i];
  const def = f.containerRef ? engine.definitions.get(f.containerRef) : null;
  return def ? def.name : 'Node';
}

function saveCurrentLevel() {
  levels[activeLevel].json = engine.toJSON();
  levels[activeLevel].viewState = { x: view.x, y: view.y, zoom: view.zoom };
  levels[activeLevel].dirty = false;
}

function getCurrentLevelJSON() {
  return engine.toJSON();
}

function isLevelDirty() {
  if (activeLevel === 0) return false;
  const f = levels[activeLevel];
  if (!f.json) return true;
  const current = getCurrentLevelJSON();
  return JSON.stringify(current) !== JSON.stringify(f.json);
}

function switchToLevel(i) {
  // commit edits on any levels deeper than the target (bottom-up)
  while (activeLevel > i) {
    if (isLevelDirty()) levels[activeLevel].dirty = true;
    commitLevel();
    activeLevel--;
    // Reload the parent snapshot: the next commitLevel (if any) must operate
    // on the parent's nodes, not the just-committed child's nodes.
    engine.fromJSON(levels[activeLevel].json);
  }
  activeLevel = i;
  if (levels[i].json) engine.fromJSON(levels[i].json);
  else engine.fromJSON({ version: 2, mode: engine.mode, definitions: [], nodes: [] });
  interactor.selection.clear();
  if (levels[i].viewState) {
    view.x = levels[i].viewState.x;
    view.y = levels[i].viewState.y;
    view.zoom = levels[i].viewState.zoom;
  } else {
    view.x = 0; view.y = 0; view.zoom = 1;
  }
  refresh();
}

// Persist the currently displayed level's edits back into its definition and
// pop it. Returns true if there was a level to commit.
function commitLevel() {
  if (activeLevel === 0) return false;
  const f = levels[activeLevel];
  const originalDef = f.containerRef ? engine.definitions.get(f.containerRef) : null;
  const circuit = buildDefinitionFromCircuit(engine, engine.getNodes().map((n) => n.id));
  const defName = originalDef ? originalDef.name : 'custom';
  let newDef = engine.registerDefinition(circuit, defName);
  if (newDef.circuit !== circuit && !sameCircuitStructure(newDef.circuit, circuit)) {
    // Same behavior but different structure (added/removed nodes, rewired
    // edges, renames, port changes, ...). Dedup-merging would silently discard
    // those edits on re-enter, so keep the edited structure instead.
    if (originalDef && newDef.id === originalDef.id) {
      engine.replaceDefinitionCircuit(originalDef.id, circuit);
      newDef = engine.definitions.get(originalDef.id);
    } else {
      // Dedup hit a *different* definition: must not rewrite it.
      newDef = engine.createDefinition(circuit, defName);
    }
  } else {
    // registerDefinition may dedupe to an existing definition; make sure the
    // (possibly shared) stored layout reflects what was just edited.
    engine.setDefinitionLayout(newDef.id, circuit);
  }
  // Apply the (possibly deduped) result to ALL instances.
  // The parent level's instances are in its saved JSON, not in the current engine.
  // Update the parent level's JSON to point to the new definition.
  if (f.containerRef && activeLevel > 0) {
    const parentLevel = levels[activeLevel - 1];
    if (parentLevel.json) {
      const data = JSON.parse(JSON.stringify(parentLevel.json));
      // Update definitions list
      const defIdx = data.definitions?.findIndex((d) => d.id === f.containerRef);
      if (defIdx >= 0) {
        // Preserve port names from the circuit
        const defWithPorts = { ...newDef, circuit: newDef.circuit };
        data.definitions[defIdx] = defWithPorts;
      }
      // Update any instances pointing to the old definition
      data.nodes?.forEach((n) => {
        if (n.kind === 'custom' && n.ref === f.containerRef) {
          n.ref = newDef.id;
          n.name = newDef.name;
          n.inputCount = newDef.inputs;
          n.outputCount = newDef.outputs;
          // Get port names from circuit.ports
          n.inputNames = (newDef.circuit?.ports?.inputs || []).slice();
          n.outputNames = (newDef.circuit?.ports?.outputs || []).slice();
        }
      });
      parentLevel.json = data;
    }
    // Also update the engine's definitions map
    engine.repointAllInstances(f.containerRef, newDef);
  } else if (f.instanceId) {
    engine.repointInstance(f.instanceId, newDef);
  }
  f.dirty = false;
  f.json = engine.toJSON();
  return true;
}

function down(node) {
  const def = engine.definitions.get(node.ref);
  if (!def) { setStatus('definition not found'); return; }
  if (isLevelDirty()) levels[activeLevel].dirty = true;
  saveCurrentLevel();
  levels.push({ json: null, containerRef: node.ref, instanceId: node.id, dirty: false });
  activeLevel = levels.length - 1;
  engine.expandDefinition(def);
  interactor.selection.clear();
  view.x = 0; view.y = 0; view.zoom = 1;
  saveCurrentLevel();
  refresh();
  setStatus(`editing internals of '${def.name}'`);
}

function up() {
  if (activeLevel === 0) { setStatus('already at root level'); return; }
  commitLevel();
  levels.pop();
  activeLevel--;
  engine.fromJSON(levels[activeLevel].json);
  interactor.selection.clear();
  if (levels[activeLevel].viewState) {
    view.x = levels[activeLevel].viewState.x;
    view.y = levels[activeLevel].viewState.y;
    view.zoom = levels[activeLevel].viewState.zoom;
  } else {
    view.x = 0; view.y = 0; view.zoom = 1;
  }
  refresh();
}

// Navigate from the tab strip to level `i` (commit any deeper levels first).
function goToLevel(i) {
  if (i === activeLevel) return;
  while (activeLevel > i) {
    if (isLevelDirty()) levels[activeLevel].dirty = true;
    commitLevel();
    levels.pop();
    activeLevel--;
    // Reload the parent snapshot: the next commitLevel (if any) must operate
    // on the parent's nodes, not the just-committed child's nodes.
    engine.fromJSON(levels[activeLevel].json);
  }
  engine.fromJSON(levels[i].json);
  interactor.selection.clear();
  if (levels[i].viewState) {
    view.x = levels[i].viewState.x;
    view.y = levels[i].viewState.y;
    view.zoom = levels[i].viewState.zoom;
  } else {
    view.x = 0; view.y = 0; view.zoom = 1;
  }
  refresh();
}

function closeToLevel(i) {
  goToLevel(i);
}

function refresh() {
  renderTabs();
  updateModeBtn();
  updateToolbar();
  renderLibrary();
  render();
}

function renderTabs() {
  const tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';
  levels.forEach((f, i) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (i === activeLevel ? ' active' : '');
    const name = document.createElement('span');
    name.textContent = levelTitle(i);
    tab.appendChild(name);
    if (i > 0) {
      const dirty = (i === activeLevel) ? isLevelDirty() : f.dirty;
      const close = document.createElement('span');
      close.className = 'tab-close' + (dirty ? ' dirty' : '');
      close.textContent = dirty ? '●' : '✕';
      close.title = dirty ? 'Unsaved changes — click for options' : 'Close this level';
      close.onclick = (e) => {
        e.stopPropagation();
        if (dirty) {
          showDirtyCloseModal(i);
        } else {
          closeToLevel(i - 1);
        }
      };
      tab.appendChild(close);
    }
    tab.onclick = () => goToLevel(i);
    tabsEl.appendChild(tab);
  });
}

// Inspector: edit a node's name and its input/output port names.
// Port rows can be reordered with ↑/↓ (wiring follows the moved ports);
// changes apply on OK, Cancel discards them.
function inspectNode(node) {
  const n = engine.nodes.get(node.id) || node;
  const inRows = (n.inputNames || []).map((nm, i) => ({
    name: nm || '', src: (n.inputs && n.inputs[i]) || null,
    sport: (n.sourcePorts && n.sourcePorts[i]) | 0, orig: i,
  }));
  const outRows = (n.outputNames || []).map((nm, i) => ({ name: nm || '', orig: i }));
  const isCustom = n.kind === NodeKind.CUSTOM;
  const renderRows = () => {
    const host = document.getElementById('insp-ports');
    if (!host) return;
    host.innerHTML = renderPortRows('in', inRows) + renderPortRows('out', outRows);
    host.querySelectorAll('input[data-row]').forEach((el) => {
      el.oninput = () => {
        const arr = el.dataset.dir === 'in' ? inRows : outRows;
        const row = arr[+el.dataset.row];
        if (row) row.name = el.value;
      };
    });
  };
  modalRoot.classList.add('open');
  modalRoot.innerHTML = `
    <div class="modal">
      <h3>${escapeHtml(n.kind.toUpperCase())} — ${escapeHtml(n.id)}</h3>
      <label>Name</label>
      <input type="text" id="insp-name" value="${escapeHtml(n.name || '')}" />
      <div class="insp-ports" id="insp-ports"></div>
      <div class="actions">
        ${isCustom ? '<button class="btn" id="modal-open">Open Internals</button>' : ''}
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn" id="modal-ok" style="background:var(--accent);color:var(--on-accent);border-color:var(--accent)">OK</button>
      </div>
    </div>`;
  renderRows();
  enableDragReorder(document.getElementById('insp-ports'), '.port-row', (items) => {
    const dir = items.length ? items[0].dataset.dir : 'in';
    const order = items.map((it) => +it.dataset.row).filter((n) => !Number.isNaN(n));
    const arr = dir === 'in' ? inRows : outRows;
    if (order.length !== arr.length) return;
    const next = order.map((k) => arr[k]);
    for (let i = 0; i < arr.length; i++) arr[i] = next[i];
    renderRows();
  });
  document.getElementById('modal-cancel').onclick = closeModal;
  const openBtn = document.getElementById('modal-open');
  if (openBtn) openBtn.onclick = () => { closeModal(); const cur = engine.nodes.get(n.id); if (cur) openCustomNode(cur); };
  document.getElementById('modal-ok').onclick = () => {
    const cur = engine.nodes.get(n.id);
    if (!cur) { closeModal(); return; }
    engine.setNodeName(n.id, document.getElementById('insp-name').value.trim());
    // Apply reordered input ports (names + wiring follow the rows).
    if (cur.inputs && inRows.length === cur.inputs.length) {
      cur.inputNames = inRows.map((r) => String(r.name || '').trim().slice(0, 16));
      cur.inputs = inRows.map((r) => r.src);
      cur.sourcePorts = inRows.map((r) => r.sport | 0);
    } else {
      inRows.forEach((r, i) => engine.setPortName(n.id, 'in', i, r.name));
    }
    // Apply reordered output ports; remap downstream wires to follow.
    if (cur.outputNames && outRows.length === cur.outputNames.length) {
      const pos = new Array(outRows.length);
      outRows.forEach((r, newIdx) => { pos[r.orig] = newIdx; });
      cur.outputNames = outRows.map((r) => String(r.name || '').trim().slice(0, 16));
      if (cur.outputs) {
        const old = cur.outputs.slice();
        cur.outputs = outRows.map((r) => old[r.orig] | 0);
      }
      engine.getNodes().forEach((m) => {
        if (!m.inputs) return;
        for (let k = 0; k < m.inputs.length; k++) {
          if (m.inputs[k] === n.id && m.sourcePorts[k] >= 0 && m.sourcePorts[k] < pos.length) {
            m.sourcePorts[k] = pos[m.sourcePorts[k]];
          }
        }
      });
    } else {
      outRows.forEach((r, i) => engine.setPortName(n.id, 'out', i, r.name));
    }
    engine.bump();
    closeModal();
    render();
  };
}

function renderPortRows(dir, rows) {
  if (rows.length === 0) return '';
  const label = dir === 'in' ? 'Input ports' : 'Output ports';
  const reorder = rows.length > 1;
  return `<div class="port-section"><div class="port-head">${label}</div>` +
    rows.map((row, i) => `
      <div class="port-row">
        <span class="port-idx">${i}</span>
        <input type="text" data-dir="${dir}" data-row="${i}" value="${escapeHtml(row.name || '')}" placeholder="name" />
        ${reorder ? `<span class="drag-handle" data-dir="${dir}" data-row="${i}" title="Drag to reorder">⠿</span>` : ''}
      </div>`).join('') + `</div>`;
}

function toggleMode() {
  const next = engine.mode === 'run' ? 'dev' : 'run';
  engine.setMode(next);
  updateModeBtn();
  updateClockCounter();
  setStatus(next === 'run' ? 'run mode: auto-clock · editing locked' : 'dev mode: manual clock only');
}

function updateModeBtn() {
  const btn = document.getElementById('mode-btn');
  const run = engine.mode === 'run';
  btn.textContent = run ? 'Dev: Edit' : 'Run: Play';
  btn.classList.toggle('active', run);
}

function updateClockCounter() {
  const el = document.getElementById('clock-counter');
  if (el) el.textContent = `clk ${engine.clock}`;
}
function doClock() {
  engine.clockStep();
  updateClockCounter();
  setStatus(`clk ${engine.clock}`);
  render();
}

function updateToolbar() {
  const run = engine.mode === 'run';
  const hasSel = interactor && interactor.selection.size > 0;
  const disabled = run || !hasSel;
  document.querySelector('[data-action="encapsulate"]').disabled = disabled;
  document.querySelector('[data-action="open-node"]').disabled = run || !(
    interactor && interactor.selection.size === 1 &&
    [...interactor.selection].every((id) => engine.nodes.get(id)?.kind === NodeKind.CUSTOM)
  );
  document.querySelector('[data-action="up-level"]').disabled = run || activeLevel === 0;
  document.querySelector('[data-action="delete"]').disabled = run || !hasSel;
  ['add-input', 'add-output', 'add-nand'].forEach((a) => {
    document.querySelector(`[data-action="${a}"]`).disabled = run;
  });
}

function deleteDefinition(def) {
  if (!window.confirm(`Delete custom node '${def.name}' and its instances?`)) return;
  engine.removeDefinition(def.id);
  renderLibrary();
  render();
  setStatus(`deleted '${def.name}'`);
}

function renderLibrary() {
  libraryEl.innerHTML = '';
  const allDefs = engine.getDefinitions();
  // When editing inside a custom node, only cycle-free definitions may be
  // inserted; others are listed but disabled.
  const containerRef = activeLevel > 0 ? (levels[activeLevel] && levels[activeLevel].containerRef) : null;
  const insertable = containerRef ? new Set(engine.insertableDefinitions(containerRef).map((d) => d.id)) : new Set(allDefs.map((d) => d.id));
  const defs = allDefs;
  for (const d of defs) {
    const item = document.createElement('div');
    item.className = 'lib-item';
    item.dataset.id = d.id;
    const blocked = containerRef && !insertable.has(d.id);
    if (blocked) item.classList.add('blocked');
    const ticksLabel = d.ticks != null ? ` · ${d.ticks}t` : '';
    item.innerHTML = `
      <div class="chip" style="background:var(--custom)">c</div>
      <div class="meta">
        <div class="name">${escapeHtml(d.name)}</div>
        <div class="desc">${d.inputs}→${d.outputs}${ticksLabel} · ${d.signature.bits.join(' ')}${blocked ? ' · would cycle' : ''}</div>
      </div>
      <span class="lib-del" data-del="${d.id}" title="Delete this custom node">✕</span>
      <span class="drag-handle" title="Drag to reorder">⠿</span>`;
    item.addEventListener('click', () => {
      if (blocked) { setStatus(`cannot insert '${d.name}': would create a cycle`); return; }
      const cw = canvas.clientWidth || 600;
      const ch = canvas.clientHeight || 400;
      const cx = cw / 2 / view.zoom + view.x;
      const cy = ch / 2 / view.zoom + view.y;
      engine.instantiate(d, cx + Math.random() * 40, cy + Math.random() * 40);
      render();
      setStatus(`added '${d.name}'`);
    });
    const del = item.querySelector('.lib-del');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteDefinition(d);
    });
    libraryEl.appendChild(item);
  }
  if (!libraryEl.dataset.dragWired) {
    libraryEl.dataset.dragWired = '1';
    enableDragReorder(libraryEl, '.lib-item', (items) => {
      const ids = items.map((it) => it.dataset.id).filter(Boolean);
      if (engine.reorderDefinitions(ids)) {
        renderLibrary();
        setStatus('library reordered');
      }
    });
  }
  if (defs.length === 0) {
    libraryEl.innerHTML = '<div class="desc" style="padding:8px;color:var(--text-dim)">No custom nodes yet.<br/>Build a circuit, select it, press Encapsulate.</div>';
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Drag-to-reorder: enableDragReorder(container, itemSel, onDone)
// Dragging the ⠿ handle on an item of itemSel (scoped to its direct parent)
// live-reorders the DOM; onDone(items) receives the items in their new order.
function enableDragReorder(container, itemSel, onDone) {
  let drag = null;
  const suppressClick = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    container.removeEventListener('click', suppressClick, true);
  };
  const finish = () => {
    if (!drag) return;
    drag.el.classList.remove('dragging');
    drag.el.style.pointerEvents = '';
    container.removeEventListener('click', suppressClick, true);
    drag = null;
  };
  container.addEventListener('pointerdown', (e) => {
    const handle = e.target && e.target.closest ? e.target.closest('.drag-handle') : null;
    if (!handle || !container.contains(handle)) return;
    const el = handle.closest(itemSel);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    container.addEventListener('click', suppressClick, true);
    drag = { el };
    el.classList.add('dragging');
    el.style.pointerEvents = 'none';
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  container.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const parent = drag.el.parentElement;
    if (!parent) return;
    const over = document.elementFromPoint(e.clientX, e.clientY);
    let target = over && over.closest(itemSel);
    const siblings = [...parent.querySelectorAll(itemSel)];
    if (!target || !siblings.includes(target)) {
      if (!siblings.length) return;
      const first = siblings[0].getBoundingClientRect();
      const last = siblings[siblings.length - 1].getBoundingClientRect();
      if (e.clientY < first.top + first.height / 2) target = siblings[0];
      else if (e.clientY > last.bottom - last.height / 2) target = siblings[siblings.length - 1];
      else return;
    }
    if (!target || target === drag.el || target.parentElement !== parent) return;
    const tb = target.getBoundingClientRect();
    const before = e.clientY < tb.top + tb.height / 2;
    if (before) parent.insertBefore(drag.el, target);
    else parent.insertBefore(drag.el, target.nextSibling);
  });
  container.addEventListener('pointerup', (e) => {
    if (!drag) return;
    e.stopPropagation();
    const parent = drag.el.parentElement;
    const items = parent ? [...parent.querySelectorAll(itemSel)] : [];
    finish();
    if (onDone) onDone(items);
  });
  container.addEventListener('pointercancel', finish);
}

function showNameModal(title, defaultName, onOk) {
  modalRoot.classList.add('open');
  modalRoot.innerHTML = `
    <div class="modal">
      <h3>${escapeHtml(title)}</h3>
      <input type="text" id="name-input" value="${escapeHtml(defaultName)}" autofocus />
      <div class="actions">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn" id="modal-ok" style="background:var(--accent);color:var(--on-accent);border-color:var(--accent)">OK</button>
      </div>
    </div>`;
  const input = document.getElementById('name-input');
  input.focus();
  input.select();
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-ok').onclick = () => { closeModal(); onOk(input.value.trim() || defaultName); };
  input.onkeydown = (e) => { if (e.key === 'Enter') { closeModal(); onOk(input.value.trim() || defaultName); } };
}

function closeModal() { modalRoot.classList.remove('open'); modalRoot.innerHTML = ''; }

function showDirtyCloseModal(levelIndex) {
  modalRoot.classList.add('open');
  modalRoot.innerHTML = `
    <div class="modal">
      <h3>Unsaved Changes</h3>
      <p>You have unsaved changes in <strong>${escapeHtml(levelTitle(levelIndex))}</strong>.</p>
      <div class="actions" style="gap: 8px; flex-wrap: wrap;">
        <button class="btn" id="dirty-save-close" style="background:var(--accent-2);color:var(--on-accent);border-color:var(--accent-2)">Save and Close</button>
        <button class="btn" id="dirty-discard-close">Close without Saving</button>
        <button class="btn" id="dirty-cancel" style="background:var(--accent);color:var(--on-accent);border-color:var(--accent)">Return to Edit</button>
      </div>
    </div>`;
  document.getElementById('dirty-save-close').onclick = () => {
    closeModal();
    // Commit and pop in one go without double-commit
    if (activeLevel === levelIndex) {
      commitLevel();
      levels.pop();
      activeLevel--;
      engine.fromJSON(levels[activeLevel].json);
      interactor.selection.clear();
      view.x = 0; view.y = 0; view.zoom = 1;
      refresh();
    } else {
      closeToLevel(levelIndex - 1);
    }
  };
  document.getElementById('dirty-discard-close').onclick = () => {
    levels[levelIndex].dirty = false;
    closeModal();
    closeToLevel(levelIndex - 1);
  };
  document.getElementById('dirty-cancel').onclick = closeModal;
}

// ---- Copy / paste (Ctrl+C / Ctrl+V) ----
let clipboard = null;

// Serialize the selected nodes plus only the wires whose both ends are in the
// selection (external wires are dropped, like encapsulation).
function copySelection() {
  const sel = new Set(interactor.selection);
  if (sel.size === 0) { setStatus('select nodes to copy'); return; }
  const nodes = engine.getNodes().filter((n) => sel.has(n.id));
  const edges = [];
  for (const n of nodes) {
    if (!n.inputs) continue;
    for (let p = 0; p < n.inputs.length; p++) {
      const src = n.inputs[p];
      if (src && sel.has(src)) edges.push({ from: src, to: n.id, port: p, srcPort: n.sourcePorts[p] | 0 });
    }
  }
  clipboard = { nodes: nodes.map((n) => ({ ...n })), edges };
  setStatus(`copied ${nodes.length} node(s)`);
}

function pasteClipboard() {
  if (!clipboard || clipboard.nodes.length === 0) { setStatus('clipboard is empty'); return; }
  const idMap = new Map();
  const off = 24;
  // clone nodes with new ids
  for (const src of clipboard.nodes) {
    const c = { ...src };
    c.id = null; // let addNode mint a fresh id
    const newNode = engine.addNode(c.kind, c.x + off, c.y + off, {
      value: c.value, inputNames: c.inputNames, outputNames: c.outputNames,
      name: c.name, ref: c.ref,
    });
    idMap.set(src.id, newNode.id);
  }
  // rewire internal edges
  for (const e of clipboard.edges) {
    const s = idMap.get(e.from), t = idMap.get(e.to);
    if (s && t) engine.connect(s, t, e.port, e.srcPort);
  }
  // select the pasted nodes
  interactor.selection.clear();
  idMap.forEach((id) => interactor.selection.add(id));
  interactor.emitSelection();
  updateToolbar();
  render();
  setStatus(`pasted ${clipboard.nodes.length} node(s)`);
}

// ---- Workspace export / import (JSON file) ----
async function exportWorkspace() {
  const data = engine.toJSON();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nandmorphic-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setStatus('workspace exported');
}

function importWorkspace(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      engine.fromJSON(data);
      levels.length = 0;
      levels.push({ json: engine.toJSON(), viewState: { x: 0, y: 0, zoom: 1 }, containerRef: null, instanceId: null, dirty: false });
      activeLevel = 0;
      interactor.selection.clear();
      view.x = 0; view.y = 0; view.zoom = 1;
      renderLibrary();
      renderTabs();
      updateToolbar();
      render();
      setStatus('workspace imported');
    } catch (err) {
      setStatus('import failed: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// Theme (dark default, light optional)
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('nandmorphic-theme', theme); } catch (e) {}
  const themeBtn = document.getElementById('theme-btn');
  if (themeBtn) {
    themeBtn.textContent = theme === 'light' ? 'Dark' : 'Light';
    themeBtn.title = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
  }
}
try {
  applyTheme(localStorage.getItem('nandmorphic-theme') === 'light' ? 'light' : 'dark');
} catch (e) {
  applyTheme('dark');
}
function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
}

// Toolbar wiring
document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const a = btn.dataset.action;
    if (a === 'mode') return toggleMode();
    if (a === 'theme') return toggleTheme();
    if (a === 'clock') return doClock();
    if (a === 'export') return exportWorkspace();
    if (a === 'import') return document.getElementById('import-file').click();
    if (a === 'zoom-in') return zoomIn();
    if (a === 'zoom-out') return zoomOut();
    if (a === 'fit-all') return fitAll();
    // everything else is an editing action: blocked in run mode
    if (engine.mode === 'run' && a !== 'clock') return;
    if (a === 'add-input') addNode(NodeKind.INPUT);
    else if (a === 'add-output') addNode(NodeKind.OUTPUT);
    else if (a === 'add-nand') addNode(NodeKind.NAND);
    else if (a === 'encapsulate') encapsulateSelection();
    else if (a === 'open-node') {
      const id = [...interactor.selection][0];
      if (id) openCustomNode(engine.nodes.get(id));
    }
    else if (a === 'up-level') up();
    else if (a === 'delete') { interactor.deleteSelected(); render(); }
  });
});

// Seed a demo circuit
function seed() {
  const i1 = engine.addNode(NodeKind.INPUT, 120, 160, { value: 0 });
  const i2 = engine.addNode(NodeKind.INPUT, 120, 240, { value: 1 });
  const n1 = engine.addNode(NodeKind.NAND, 260, 200);
  engine.connect(i1.id, n1.id, 0);
  engine.connect(i2.id, n1.id, 1);
  const o1 = engine.addNode(NodeKind.OUTPUT, 400, 200);
  engine.connect(n1.id, o1.id, 0);
  // prime one clock so combinational output is visible immediately
  engine.clockStep();
  updateClockCounter();
  setStatus('NAND(A=0,B=1)=1 · Space advances clock');
  console.info('[nandmorphic] BUILD B4 · library/port reorder');
}

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's' && !e.shiftKey) { e.preventDefault(); commitLevel(); refresh(); setStatus('saved'); }
  else if (mod && e.key.toLowerCase() === 's' && e.shiftKey) { e.preventDefault(); exportWorkspace(); }
  else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); }
  else if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); exportWorkspace(); }
  else if (mod && e.key.toLowerCase() === 'c') { copySelection(); }
  else if (mod && e.key.toLowerCase() === 'v') { pasteClipboard(); }
  else if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); doClock(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { interactor.deleteSelected(); render(); }
  else if (e.key.toLowerCase() === 'i' && engine.mode !== 'run') addNode(NodeKind.INPUT);
  else if (e.key.toLowerCase() === 'o' && engine.mode !== 'run') addNode(NodeKind.OUTPUT);
  else if (e.key.toLowerCase() === 'n' && engine.mode !== 'run') addNode(NodeKind.NAND);
  else if (e.key.toLowerCase() === 'e' && engine.mode !== 'run') encapsulateSelection();
  else if (e.key === 'c' && engine.mode !== 'run') doClock();
  else if (e.key === 'Escape') {
    if (activeLevel > 0 && interactor.selection.size === 0) { up(); }
    else { interactor.selection.clear(); interactor.emitSelection(); updateToolbar(); render(); }
  }
  else if (e.key === '=' || e.key === '+') { zoomIn(); }
  else if (e.key === '-') { zoomOut(); }
  else if (e.key.toLowerCase() === 'f' && !mod) { fitAll(); }
});

// Import file handling
document.getElementById('import-file').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importWorkspace(file);
  e.target.value = '';
});

let clkFreq = 6;
function setClkFreq(v) {
  clkFreq = Math.max(1, Math.min(20, v | 0));
  const r = document.getElementById('clkfreq-range');
  const l = document.getElementById('clkfreq-label');
  if (r) r.value = String(clkFreq);
  if (l) l.textContent = String(clkFreq);
}

// Render loop — in RUN mode auto-clock at clkFreq Hz
let lastAutoClock = 0;
let _lastTabRenderVersion = -1;
function loop(ts) {
  const now = ts || performance.now();
  render();
  // Re-render tabs when engine state changes (dirty indicator, etc.)
  if (engine.version !== _lastTabRenderVersion) {
    _lastTabRenderVersion = engine.version;
    renderTabs();
  }
  const interval = 1000 / clkFreq;
  if (engine.mode === 'run' && now - lastAutoClock >= interval) {
    lastAutoClock = now;
    engine.clockStep();
    updateClockCounter();
  }
  requestAnimationFrame(loop);
}

window.addEventListener('resize', resize);

resize();
initInteractor();
levels.push({ json: engine.toJSON(), viewState: { x: 0, y: 0, zoom: 1 }, containerRef: null, instanceId: null, dirty: false });
updateToolbar();
updateModeBtn();
renderLibrary();
renderTabs();
seed();
// Clock frequency slider wiring
document.getElementById('clkfreq-range')?.addEventListener('input', (e) => setClkFreq(parseInt(e.target.value, 10) || 6));
setClkFreq(6);
loop();