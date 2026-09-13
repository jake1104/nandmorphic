// Renderer: draws the circuit graph onto the canvas. Pure draw functions;
// interaction is handled by interact.js.
//
// Nodes are drawn as rounded rectangles whose size depends on port count and
// the longest label/port-name. Each input port shows (if set) its name on the
// left; each output port shows (if set) its name + live value.

import { NodeKind, defaultLabel } from './model.js';
import {
  NODE_R, PORT_R, inputPortPos, outputPortPos,
  inputPortCount, outputPortCount, nodeSize,
} from './ports.js';

const COLORS = {
  [NodeKind.NAND]: '#ff7b72',
  [NodeKind.INPUT]: '#a5d6ff',
  [NodeKind.OUTPUT]: '#c3e88d',
  [NodeKind.CUSTOM]: '#d2a8ff',
  [NodeKind.CONST]: '#e3b341',
};

const KIND_VARS = {
  [NodeKind.NAND]: '--nand',
  [NodeKind.INPUT]: '--input',
  [NodeKind.OUTPUT]: '--output',
  [NodeKind.CUSTOM]: '--custom',
  [NodeKind.CONST]: '--const',
};

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const FONT = '600 11px "Segoe UI", sans-serif';

// Longest text that must fit in the body: the label plus the longest port name.
export function longestText(node, values) {
  const parts = [defaultLabel(node)];
  if (node.name) parts.push(node.name);
  for (let p = 0; p < inputPortCount(node); p++) {
    if (node.inputNames && node.inputNames[p]) parts.push(node.inputNames[p]);
  }
  for (let p = 0; p < outputPortCount(node); p++) {
    const nm = node.outputNames && node.outputNames[p] ? node.outputNames[p] : '';
    parts.push(nm || valueText(node, values, p));
  }
  return parts.reduce((a, b) => (b.length > a.length ? b : a), '');
}

function valueText(node, values, p) {
  const v = outletValue(node, values, p);
  return v === undefined ? '' : String(v);
}

// Node width/height given values; used by both renderer and hit-testing.
export function nodeBox(node, values) {
  return nodeSize(node, longestText(node, values));
}

export function draw(ctx, engine, view, selection, hover, hoverPort = null) {
  const dpr = window.devicePixelRatio || 1;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(-view.x * view.zoom, -view.y * view.zoom);
  ctx.scale(view.zoom, view.zoom);

  const nodes = engine.getNodes();
  const values = engine.evaluate();

  // wires first (under nodes)
  for (const n of nodes) {
    if (!n.inputs) continue;
    n.inputs.forEach((srcId, port) => {
      if (!srcId) return;
      const src = engine.nodes.get(srcId);
      if (!src) return;
      const srcPort = n.sourcePorts ? n.sourcePorts[port] : 0;
      const active = outletValue(src, values, srcPort) === 1;
      drawWire(ctx, src, srcPort, n, port, active, values);
    });
  }

  // nodes
  for (const n of nodes) {
    const hp = hoverPort && hoverPort.node && hoverPort.node.id === n.id ? hoverPort : null;
    drawNode(ctx, n, values, selection.has(n.id), hover === n.id, hp);
  }

  ctx.restore();
}

function outletValue(node, values, srcPort = 0) {
  if (node.kind === NodeKind.OUTPUT) return (values.get(node.id) || 0) | 0;
  if (node.kind === NodeKind.INPUT) return node.value | 0;
  if (node.kind === NodeKind.CONST) return node.value | 0;
  if (node.kind === NodeKind.NAND) return (values.get(node.id) || 0) | 0;
  if (node.kind === NodeKind.CUSTOM) {
    const outs = values.get(node.id);
    return Array.isArray(outs) ? (outs[srcPort] | 0) : 0;
  }
  return 0;
}

function drawWire(ctx, src, srcPort, dst, port, active, values) {
  const s = outputPortPos(src, srcPort, nodeBox(src, values).w / 2);
  const d = inputPortPos(dst, port, nodeBox(dst, values).w / 2);
  const backward = s.x >= d.x - 8;
  ctx.beginPath();
  ctx.strokeStyle = active ? 'rgba(126,231,135,0.9)' : cssVar('--wire-dim', 'rgba(139,148,158,0.45)');
  ctx.lineWidth = backward ? 2.0 : 2.2;
  if (backward) ctx.setLineDash([]);
  ctx.moveTo(s.x, s.y);
  if (!backward) {
    const mx = (s.x + d.x) / 2;
    ctx.bezierCurveTo(mx, s.y, mx, d.y, d.x, d.y);
  } else {
    const dx = Math.abs(s.x - d.x);
    const dy = Math.abs(s.y - d.y);
    const rise = 48 + Math.min(90, dx * 0.22 + dy * 0.12);
    const srcBelowDst = src.y > dst.y;
    const bendY = srcBelowDst ? Math.max(s.y, d.y) + rise : Math.min(s.y, d.y) - rise;
    const midX = (s.x + d.x) / 2;
    const c1x = s.x + 22;
    const c2x = d.x - 22;
    ctx.bezierCurveTo(c1x, s.y, c1x, bendY, midX, bendY);
    ctx.bezierCurveTo(c2x, bendY, c2x, d.y, d.x, d.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  if (backward) {
    const dx = Math.abs(s.x - d.x);
    const dy = Math.abs(s.y - d.y);
    const rise = 48 + Math.min(90, dx * 0.22 + dy * 0.12);
    const srcBelowDst = src.y > dst.y;
    const bendY = srcBelowDst ? Math.max(s.y, d.y) + rise : Math.min(s.y, d.y) - rise;
    const midX = (s.x + d.x) / 2;
    ctx.beginPath();
    ctx.fillStyle = active ? 'rgba(126,231,135,0.9)' : cssVar('--wire-dim', 'rgba(139,148,158,0.35)');
    ctx.arc(midX, bendY, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawNode(ctx, node, values, selected, hover, hoverPort) {
  const baseVar = cssVar(KIND_VARS[node.kind], COLORS[node.kind]) || cssVar('--node', '#8b949e');
  // per-instance color override (all kinds)
  const color = (node.color && /^#[0-9a-fA-F]{3,8}$/.test(node.color)) ? node.color : baseVar;
  const { w, h } = nodeBox(node, values);
  const hw = w / 2, hh = h / 2;

  ctx.save();

  // body: rounded rect. INPUT/OUTPUT/CONST brightness tracks live state.
  const bodyColor = stateAwareColor(node, values, color);

  roundRectPath(ctx, node.x - hw, node.y - hh, w, h, 8);
  ctx.fillStyle = bodyColor.fill;
  ctx.fill();
  ctx.lineWidth = selected ? 3 : 2;
  ctx.strokeStyle = selected ? '#58a6ff' : hover ? cssVar('--hover-stroke', '#fff') : bodyColor.stroke;
  ctx.stroke();

  // center label (node name / kind / live value for OUTPUT/INPUT)
  ctx.fillStyle = bodyColor.text;
  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(centerLabel(node, values), node.x, node.y);

  // port labels
  ctx.font = '500 11px "Segoe UI", sans-serif';
  for (let p = 0; p < inputPortCount(node); p++) {
    const pos = inputPortPos(node, p, hw);
    const nm = node.inputNames && node.inputNames[p] ? node.inputNames[p] : '';
    if (nm) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = cssVar('--text-dim', '#c9d1d9');
      ctx.fillText(nm, pos.x - 8, pos.y);
    }
    drawPort(ctx, pos.x, pos.y, true, !!(hoverPort && hoverPort.dir === 'in' && hoverPort.port === p));
  }
  for (let p = 0; p < outputPortCount(node); p++) {
    const pos = outputPortPos(node, p, hw);
    const nm = node.outputNames && node.outputNames[p] ? node.outputNames[p] : '';
    if (nm) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = cssVar('--text-dim', '#c9d1d9');
      ctx.fillText(nm, pos.x + 8, pos.y);
    }
    drawPort(ctx, pos.x, pos.y, false, !!(hoverPort && hoverPort.dir === 'out' && hoverPort.port === p));
  }
  // per-instance memo below the body
  if (node.memo) {
    ctx.font = '500 10px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = cssVar('--text-dim', '#c9d1d9');
    const lines = String(node.memo).split('\n').slice(0, 3);
    lines.forEach((ln, li) => {
      ctx.fillText(ln.slice(0, 32), node.x, node.y + hh + 4 + li * 12);
    });
  }

  ctx.restore();
}

// INPUT/OUTPUT/CONST node background brightness tracks its live value.
// CUSTOM follows its live outputs (bright if any output port is 1).
function stateAwareColor(node, values, base) {
  let v = 0;
  if (node.kind === NodeKind.INPUT) v = node.value | 0;
  else if (node.kind === NodeKind.CONST) v = node.value | 0;
  else if (node.kind === NodeKind.OUTPUT) v = (values.get(node.id) || 0) | 0;
  else if (node.kind === NodeKind.CUSTOM) {
    const outs = values.get(node.id);
    v = Array.isArray(outs) ? (outs.some((b) => (b | 0) === 1) ? 1 : 0) : ((outs | 0) ? 1 : 0);
  }
  else return { fill: base + '22', stroke: base, text: base };

  if (v) {
    // bright "on" state
    return { fill: base + 'cc', stroke: base, text: '#0d1117' };
  }
  return { fill: base + '22', stroke: base, text: base };
}

function centerLabel(node, values) {
  switch (node.kind) {
    case NodeKind.INPUT: return node.name || (node.value ? '1' : '0');
    case NodeKind.CONST: return node.name || String(node.value | 0);
    case NodeKind.OUTPUT: return node.name || String((values.get(node.id) || 0) | 0);
    case NodeKind.NAND: return node.name || 'NAND';
    case NodeKind.CUSTOM: return node.name || 'CUSTOM';
    default: return defaultLabel(node);
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawPort(ctx, x, y, isInput = false, hovered = false) {
  const fill = cssVar('--port-fill', '#e6edf3');
  ctx.beginPath();
  ctx.arc(x, y, hovered ? PORT_R + 2 : PORT_R, 0, Math.PI * 2);
  ctx.fillStyle = hovered ? '#7ee787' : fill;
  ctx.fill();
  ctx.lineWidth = hovered ? 2.5 : 1.5;
  ctx.strokeStyle = hovered ? '#7ee787' : (isInput ? cssVar('--port-stroke', '#8b949e') : fill);
  ctx.stroke();
}

export function nodeAt(nodes, values, x, y) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const dx = n.x - x;
    const dy = n.y - y;
    if (dx * dx + dy * dy <= NODE_R * NODE_R * 1.4) return n;
  }
  // fallback: box hit-test on rounded rect
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const { w, h } = nodeBox(n, values);
    if (Math.abs(x - n.x) <= w / 2 && Math.abs(y - n.y) <= h / 2) return n;
  }
  return null;
}

// Ports are clickable within this radius of their center, even when the port
// hangs slightly off the node body edge.
const PORT_HIT_R = 16;

export function outputPortAt(node, x, y, values) {
  const hw = nodeBox(node, values).w / 2;
  for (let p = 0; p < outputPortCount(node); p++) {
    const pos = outputPortPos(node, p, hw);
    const dx = x - pos.x;
    const dy = y - pos.y;
    if (dx * dx + dy * dy <= PORT_HIT_R * PORT_HIT_R) return p;
  }
  return -1;
}

export function inputPortAt(node, x, y, values) {
  const hw = nodeBox(node, values).w / 2;
  for (let p = 0; p < inputPortCount(node); p++) {
    const pos = inputPortPos(node, p, hw);
    const dx = x - pos.x;
    const dy = y - pos.y;
    if (dx * dx + dy * dy <= PORT_HIT_R * PORT_HIT_R) return p;
  }
  return -1;
}

export const NODE_HIT_R = NODE_R;