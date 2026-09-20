// Interact: mouse + keyboard handling for node interaction.
//   - click an INPUT toggles its value
//   - drag a node to move it
//   - ComfyUI-style wiring: drag from a node's OUTPUT port, release on an
//     input port (or empty space to cancel). A tether line follows the cursor
//     and the nearest input port under the cursor highlights to show the drop
//     target. Dragging a wire that already has a connection re-routes it;
//     releasing into empty space disconnects it.
//   - click empty space + drag = marquee selection
//   - Delete key removes selected nodes

import { NodeKind } from './model.js';
import { nodeAt, outputPortAt, inputPortAt, NODE_HIT_R, nodeBox, cssVar } from './renderer.js';
import { inputPortPos, outputPortPos, inputPortCount, outputPortCount } from './ports.js';

export class Interactor {
  constructor(engine, canvas, view, hooks) {
    this.engine = engine;
    this.canvas = canvas;
    this.view = view;
    this.hooks = hooks || {};
    this.selection = new Set();
    this.mode = null; // null | 'drag' | 'wire' | 'marquee' | 'pan'
    this.dragNode = null;
    this.dragMoved = false;
    this.dragStart = null;
    this.wire = null; // { srcNode, srcPort, live }, live = wire currently being pulled
    this.wireCursor = null; // { x, y }
    this.snapTarget = null; // { node, port } input drop candidate while wiring
    this.snapSource = null; // { node, port } output candidate while re-routing
    this.marquee = null;
    this.hover = null; // hovered node id (body)
    this.hoverPort = null; // { node, dir:'in'|'out', port }
    this.panStart = null; // { sx, sy, vx, vy } for middle-click pan
    this.needsRender = false; // canvas needs a redraw (set by handlers, cleared by the render loop)
  }

  screenToWorld(sx, sy) {
    return {
      x: sx / this.view.zoom + this.view.x,
      y: sy / this.view.zoom + this.view.y,
    };
  }

  toWorld(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    return this.screenToWorld(sx, sy);
  }

  onPointerDown(e) {
    const p = this.toWorld(e);
    const nodes = this.engine.getNodes();
    const values = this.engine.evaluate();
    const node = nodeAt(nodes, values, p.x, p.y);

    // middle-click: start panning
    if (e.button === 1) {
      e.preventDefault();
      this.mode = 'pan';
      this.panStart = { sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
      return;
    }

    // Port circles straddle the body edge: their outer half sits beyond the
    // body rect, so a body hit is not guaranteed. Find a port hit anywhere
    // (body hit OR just outside), preferring the closest.
    let outHit = null; // {node, port}
    let inHit = null;  // {node, port}
    for (const n of nodes) {
      const op = outputPortAt(n, p.x, p.y, values);
      if (op >= 0) outHit = { node: n, port: op };
      const ip = inputPortAt(n, p.x, p.y, values);
      if (ip >= 0) inHit = { node: n, port: ip };
    }

    // Run mode: only INPUT clicks toggle; no wiring/drag/marquee.
    if (this.engine.mode === 'run') {
      if (node && node.kind === NodeKind.INPUT) {
        this.engine.toggleInput(node.id);
        if (this.hooks.onStatus) this.hooks.onStatus('toggled input');
        this.engine.bump();
      }
      // middle-click pans even in run mode
      if (e.button === 1) {
        e.preventDefault();
        this.mode = 'pan';
        this.panStart = { sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
      }
      return;
    }

    // 1. grab an OUTPUT port -> start a wire
    if (outHit) {
      this.mode = 'wire';
      this.wire = { srcNode: outHit.node, srcPort: outHit.port };
      this.wireCursor = p;
      this.updateSnap(p);
      return;
    }

    // 2. grab an INPUT port that already has a connection -> re-route it
    if (inHit && inHit.node.inputs && inHit.node.inputs[inHit.port]) {
      const srcId = inHit.node.inputs[inHit.port];
      const srcNode = this.engine.nodes.get(srcId);
      inHit.node.inputs[inHit.port] = null;
      this.engine.bump();
      if (this.hooks.onWire) this.hooks.onWire(null, inHit.node, inHit.port);
      this.mode = 'wire';
      this.wire = { srcNode: srcNode || null, srcPort: -1, reroute: { dst: inHit.node, port: inHit.port } };
      this.wireCursor = p;
      this.updateSnap(p);
      return;
    }

    // 3. node body -> drag (or toggle INPUT on click)
    if (node) {
      this.mode = 'drag';
      this.dragNode = node;
      this.dragMoved = false;
      this.dragStart = p;
      if (node.kind !== NodeKind.INPUT && !this.selection.has(node.id)) {
        if (!e.shiftKey) this.selection.clear();
        this.selection.add(node.id);
        this.emitSelection();
      } else if (node.kind === NodeKind.INPUT && !this.selection.has(node.id)) {
        if (!e.shiftKey) this.selection.clear();
        this.selection.add(node.id);
        this.emitSelection();
      }
      return;
    }

    // 4. empty space -> marquee
    this.mode = 'marquee';
    this.marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    if (!e.shiftKey) this.selection.clear();
    this.emitSelection();
  }

  onPointerMove(e) {
    const p = this.toWorld(e);
    const nodes = this.engine.getNodes();

    if (this.mode === 'pan' && this.panStart) {
      const dx = e.clientX - this.panStart.sx;
      const dy = e.clientY - this.panStart.sy;
      this.view.x = this.panStart.vx - dx / this.view.zoom;
      this.view.y = this.panStart.vy - dy / this.view.zoom;
      this.canvas.style.cursor = 'grabbing';
      this.needsRender = true; // pan mutates the view; the loop is its only redraw path
      return;
    }

    if (this.mode === 'wire') {
      this.wireCursor = p;
      this.updateSnap(p);
      if (this.wire && this.wire.reroute) {
        this.hoverPort = this.snapSource ? { node: this.snapSource.node, dir: 'out', port: this.snapSource.port } : null;
      } else {
        this.hoverPort = this.snapTarget ? { node: this.snapTarget.node, dir: 'in', port: this.snapTarget.port } : null;
      }
      this.hover = null;
      this.needsRender = true;
      return;
    }

    if (this.mode === 'drag' && this.dragNode) {
      const dx = p.x - this.dragStart.x;
      const dy = p.y - this.dragStart.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.dragMoved = true;
      // move all selected nodes together
      if (this.selection.has(this.dragNode.id)) {
        const ids = this.selection;
        const off = { x: p.x - this.dragNode.x, y: p.y - this.dragNode.y };
        for (const n of nodes) {
          if (ids.has(n.id)) { n.x += off.x; n.y += off.y; }
        }
      } else {
        this.dragNode.x = p.x;
        this.dragNode.y = p.y;
      }
      this.engine.bumpLight();
      this.hover = this.dragNode.id;
      this.needsRender = true;
      return;
    }

    if (this.mode === 'marquee' && this.marquee) {
      this.marquee.x1 = p.x;
      this.marquee.y1 = p.y;
      this.hover = null;
      this.needsRender = true;
      return;
    }

    // idle: update hover state (node body or port). Ports straddle the body
    // edge, so scan every node for a port hit (works slightly off-body too).
    // The render loop only redraws when hover actually changes, so compare
    // against the previous state (by value — hoverPort is a fresh object
    // each pass).
    const prevHover = this.hover;
    const prevPort = this.hoverPort;
    const val2 = this.engine.evaluate();
    const node = nodeAt(nodes, val2, p.x, p.y);
    this.hover = node ? node.id : null;
    this.hoverPort = null;
    for (const n of nodes) {
      const op = outputPortAt(n, p.x, p.y, val2);
      if (op >= 0) { this.hoverPort = { node: n, dir: 'out', port: op }; break; }
      const ip = inputPortAt(n, p.x, p.y, val2);
      if (ip >= 0) { this.hoverPort = { node: n, dir: 'in', port: ip }; break; }
    }
    this.canvas.style.cursor = this.hoverPort ? 'pointer' : (this.hover ? 'grab' : 'default');
    const portChanged = (this.hoverPort === null) !== (prevPort === null) ||
      (this.hoverPort !== null && prevPort !== null &&
        (this.hoverPort.node !== prevPort.node || this.hoverPort.dir !== prevPort.dir || this.hoverPort.port !== prevPort.port));
    if (this.hover !== prevHover || portChanged) this.needsRender = true;
  }

  onPointerUp(e) {
    const p = this.toWorld(e);

    if (this.mode === 'wire') {
      this.finishWire(p);
    } else if (this.mode === 'drag' && this.dragNode && !this.dragMoved) {
      // dev(edit) mode: click a CONST body toggles its fixed value.
      // (INPUT toggling stays run-mode only; CONST is locked in run mode.)
      if (this.engine.mode !== 'run' && this.dragNode.kind === NodeKind.CONST) {
        this.engine.toggleConst(this.dragNode.id);
        if (this.hooks.onStatus) this.hooks.onStatus(`const = ${this.dragNode.value | 0}`);
      }
    } else if (this.mode === 'marquee' && this.marquee) {
      const x0 = Math.min(this.marquee.x0, this.marquee.x1);
      const y0 = Math.min(this.marquee.y0, this.marquee.y1);
      const x1 = Math.max(this.marquee.x0, this.marquee.x1);
      const y1 = Math.max(this.marquee.y0, this.marquee.y1);
      this.selection.clear();
      for (const n of this.engine.getNodes()) {
        if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1) this.selection.add(n.id);
      }
      this.emitSelection();
      this.marquee = null;
    }

    this.mode = null;
    this.dragNode = null;
    this.wire = null;
    this.wireCursor = null;
    this.snapTarget = null;
    this.snapSource = null;
    this.panStart = null;
    this.engine.bumpLight();
  }

  onDoubleClick(e) {
    if (this.engine.mode === 'run') return;
    const p = this.toWorld(e);
    const node = nodeAt(this.engine.getNodes(), this.engine.evaluate(), p.x, p.y);
    if (!node) return;
    // Every node (including CUSTOM) opens the inspector settings window;
    // custom-node internals are reached via "Open Internals" / toolbar.
    if (this.hooks.onInspectNode) {
      this.hooks.onInspectNode(node);
    }
  }

  // During a pull, find the nearest port to snap the tether to.
  // Fresh wire (output -> input): snap to the nearest INPUT port.
  // Re-route (input's old wire): snap to the nearest OUTPUT port so the
  // user can pick a new source. Port circles sit on the node edge, so both
  // are matched by circle distance — including the outer half outside the body.
  updateSnap(p) {
    const nodes = this.engine.getNodes();
    const values = this.engine.evaluate();
    const isReroute = !!(this.wire && this.wire.reroute);
    let bestIn = null;
    let bestInDist = Infinity;
    let bestOut = null;
    let bestOutDist = Infinity;
    for (const n of nodes) {
      const inN = inputPortCount(n);
      const hw = nodeBox(n, values).w / 2;
      for (let port = 0; port < inN; port++) {
        const pos = inputPortPos(n, port, hw);
        const dx = p.x - pos.x;
        const dy = p.y - pos.y;
        const d = dx * dx + dy * dy;
        if (d < bestInDist) { bestInDist = d; bestIn = { node: n, port, dist: d }; }
      }
      const outN = outputPortCount(n);
      for (let port = 0; port < outN; port++) {
        const pos = outputPortPos(n, port, hw);
        const dx = p.x - pos.x;
        const dy = p.y - pos.y;
        const d = dx * dx + dy * dy;
        if (isReroute && this.wire.reroute.dst && n.id === this.wire.reroute.dst.id) continue;
        if (d < bestOutDist) { bestOutDist = d; bestOut = { node: n, port, dist: d }; }
      }
    }
    if (bestIn && bestInDist < 12 * 12) this.snapTarget = { node: bestIn.node, port: bestIn.port };
    else this.snapTarget = null;
    if (bestOut && bestOutDist < 12 * 12) this.snapSource = { node: bestOut.node, port: bestOut.port };
    else this.snapSource = null;
  }

  finishWire(p) {
    const wire = this.wire;
    if (!wire) return;

    // choose drop target: snapped port, else any port under cursor
    // (circle hit works outside the body edge too).
    let target = this.snapTarget;
    if (!target) {
      const node = nodeAt(this.engine.getNodes(), this.engine.evaluate(), p.x, p.y);
      if (node) {
        const port = inputPortAt(node, p.x, p.y, this.engine.evaluate());
        if (port >= 0) target = { node, port };
      }
    }
    let source = this.snapSource;
    if (!source) {
      for (const n of this.engine.getNodes()) {
        const port = outputPortAt(n, p.x, p.y, this.engine.evaluate());
        if (port >= 0) {
          if (wire.reroute && wire.reroute.dst && n.id === wire.reroute.dst.id) continue;
          source = { node: n, port };
          break;
        }
      }
    }

    if (wire.reroute) {
      // re-routing an existing connection: new source -> original input
      if (source) {
        this.engine.connect(source.node.id, wire.reroute.dst.id, wire.reroute.port, source.port);
        if (this.hooks.onWire) this.hooks.onWire(source.node, wire.reroute.dst, wire.reroute.port);
      }
      // else: dropped into empty space -> connection stays removed (disconnect)
      return;
    }

    if (!wire.srcNode) return;

    if (target && target.node !== wire.srcNode) {
      this.engine.connect(wire.srcNode.id, target.node.id, target.port, wire.srcPort);
      if (this.hooks.onWire) this.hooks.onWire(wire.srcNode, target.node, target.port);
    }
    // dropped into empty space: no-op (nothing to disconnect for a fresh pull)
  }

  deleteSelected() {
    if (this.engine.mode === 'run') return;
    let removed = 0;
    this.selection.forEach((id) => {
      this.engine.removeNode(id);
      removed++;
    });
    this.selection.clear();
    this.emitSelection();
    this.engine.bump();
    if (this.hooks.onStatus) this.hooks.onStatus(`deleted ${removed} node(s)`);
  }

  emitSelection() {
    this.needsRender = true; // selection stroke is drawn on the canvas
    if (this.hooks.onSelectionChange) this.hooks.onSelectionChange(this.selection);
  }

  drawOverlay(ctx, view) {
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(-view.x * view.zoom, -view.y * view.zoom);
    ctx.scale(view.zoom, view.zoom);

    if (this.marquee) {
      const x = Math.min(this.marquee.x0, this.marquee.x1);
      const y = Math.min(this.marquee.y0, this.marquee.y1);
      const w = Math.abs(this.marquee.x1 - this.marquee.x0);
      const h = Math.abs(this.marquee.y1 - this.marquee.y0);
      ctx.fillStyle = 'rgba(88,166,255,0.12)';
      ctx.strokeStyle = '#58a6ff';
      ctx.lineWidth = 1.5;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }

    // current pulled wire tether
    if (this.wire && this.wireCursor) {
      const values = this.engine.evaluate();
      const isReroute = !!(this.wire && this.wire.reroute);
      let s, d;
      if (isReroute) {
        const dst = this.wire.reroute.dst;
        d = inputPortPos(dst, this.wire.reroute.port, nodeBox(dst, values).w / 2);
        s = this.snapSource
          ? outputPortPos(this.snapSource.node, this.snapSource.port, nodeBox(this.snapSource.node, values).w / 2)
          : this.wireCursor;
      } else {
        s = this.wire.srcNode
          ? outputPortPos(this.wire.srcNode, Math.max(this.wire.srcPort, 0), nodeBox(this.wire.srcNode, values).w / 2)
          : this.wireCursor;
        d = this.snapTarget
          ? inputPortPos(this.snapTarget.node, this.snapTarget.port, nodeBox(this.snapTarget.node, values).w / 2)
          : this.wireCursor;
      }

      const backward = s.x >= d.x - 8;
      ctx.beginPath();
      ctx.strokeStyle = cssVar('--tether', 'rgba(255,255,255,0.75)');
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.moveTo(s.x, s.y);
      if (!backward) {
        const mx = (s.x + d.x) / 2;
        ctx.bezierCurveTo(mx, s.y, mx, d.y, d.x, d.y);
      } else {
        const dx = Math.abs(s.x - d.x);
        const dy = Math.abs(s.y - d.y);
        const rise = 48 + Math.min(90, dx * 0.22 + dy * 0.12);
        const srcNodeY = this.wire.srcNode ? this.wire.srcNode.y : s.y;
        const dstNodeY = this.snapTarget ? this.snapTarget.node.y : d.y;
        const srcBelowDst = srcNodeY > dstNodeY;
        const bendY = srcBelowDst ? Math.max(s.y, d.y) + rise : Math.min(s.y, d.y) - rise;
        const midX = (s.x + d.x) / 2;
        const c1x = s.x + 22, c2x = d.x - 22;
        ctx.bezierCurveTo(c1x, s.y, c1x, bendY, midX, bendY);
        ctx.bezierCurveTo(c2x, bendY, c2x, d.y, d.x, d.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // highlight snap target port (input for fresh wire, output for re-route)
      // Circles sit on the node edge: highlight by circle distance so the
      // outer half outside the body still lights up.
      const hl = (node, port, dir) => {
        const pos = dir === 'in'
          ? inputPortPos(node, port, nodeBox(node, values).w / 2)
          : outputPortPos(node, port, nodeBox(node, values).w / 2);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(126,231,135,0.35)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#7ee787';
        ctx.stroke();
      };
      if (this.wire.reroute) {
        if (this.snapSource) hl(this.snapSource.node, this.snapSource.port, 'out');
      } else if (this.snapTarget) {
        hl(this.snapTarget.node, this.snapTarget.port, 'in');
      }
      // while dragging, any output port under the cursor also lights up
      if (this.hoverPort && this.hoverPort.dir === 'out') {
        hl(this.hoverPort.node, this.hoverPort.port, 'out');
      }
    } else if (this.hoverPort && !this.mode) {
      // idle hover: highlight the port under the cursor
      const hp = this.hoverPort;
      const values = this.engine.evaluate();
      const pos = hp.dir === 'in'
        ? inputPortPos(hp.node, hp.port, nodeBox(hp.node, values).w / 2)
        : outputPortPos(hp.node, hp.port, nodeBox(hp.node, values).w / 2);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(126,231,135,0.25)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#7ee787';
      ctx.stroke();
    }

    ctx.restore();
  }
}

function inputPortCountFor(node) {
  return inputPortCount(node);
}