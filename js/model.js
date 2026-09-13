// Circuit model: types, evaluation, and graph utilities.
// Pure (no DOM/canvas) so it can be tested independently.

export const NodeKind = {
  INPUT: 'input',
  OUTPUT: 'output',
  NAND: 'nand',
  CUSTOM: 'custom',
  CONST: 'const',
};

// Default name used as a label fallback per node kind.
export function defaultLabel(node) {
  switch (node.kind) {
    case NodeKind.INPUT: return 'IN';
    case NodeKind.OUTPUT: return 'OUT';
    case NodeKind.NAND: return 'NAND';
    case NodeKind.CONST: return node.value ? '1' : '0';
    case NodeKind.CUSTOM: return node.name || 'CUSTOM';
    default: return '';
  }
}

// "Truth-table" style signature over a subset of inputs.
// Used to detect isomorphic custom nodes (see optimizer.js).
export function computeSignature(inputs, outputs, evalFn) {
  const n = inputs.length;
  const rows = 1 << n;
  const sig = new Array(outputs.length);
  for (let o = 0; o < outputs.length; o++) sig[o] = 0;
  for (let r = 0; r < rows; r++) {
    const inVals = new Array(n);
    for (let i = 0; i < n; i++) inVals[i] = (r >> i) & 1;
    const out = evalFn(inVals);
    for (let o = 0; o < outputs.length; o++) {
      sig[o] = (sig[o] << 1) | (out[o] ? 1 : 0);
    }
  }
  return sig;
}

// Evaluate a value off inputs based on node wiring.
export function evaluateValue(node, nodeMap, memo, visiting) {
  if (memo.has(node.id)) return memo.get(node.id);
  if (visiting.has(node.id)) return 0; // cycle guard
  visiting.add(node.id);

  let result;
  switch (node.kind) {
    case NodeKind.INPUT:
    case NodeKind.CONST:
    case NodeKind.PULSE:
      result = node.value ? 1 : 0;
      break;
    case NodeKind.OUTPUT: {
      const src = node.inputs && node.inputs[0];
      result = src ? evaluateValue(nodeMap.get(src), nodeMap, memo, visiting) : 0;
      break;
    }
    case NodeKind.NAND: {
      const a = node.inputs[0] ? evaluateValue(nodeMap.get(node.inputs[0]), nodeMap, memo, visiting) : 0;
      const b = node.inputs[1] ? evaluateValue(nodeMap.get(node.inputs[1]), nodeMap, memo, visiting) : 0;
      result = (a && b) ? 0 : 1;
      break;
    }
    case NodeKind.CUSTOM:
      result = 0; // engine flattens custom nodes
      break;
    default:
      result = 0;
  }

  visiting.delete(node.id);
  memo.set(node.id, result);
  return result;
}

// Topologically iterate a graph; runs fn(node) per node in dependency order.
export function forEachTopological(nodes, getDeps, fn) {
  const state = new Map();
  nodes.forEach((n) => state.set(n.id, 0));
  const visit = (id) => {
    const s = state.get(id);
    if (s === 2 || s === 1) return;
    state.set(id, 1);
    const deps = getDeps(id) || [];
    deps.forEach((d) => { if (state.has(d)) visit(d); });
    state.set(id, 2);
    fn(id);
  };
  nodes.forEach((n) => visit(n.id));
}

let idCounter = 0;
export function makeId(prefix = 'n') {
  idCounter = (idCounter + 1) % 0xffffff;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}
