// Optimizer: detect structurally/behaviorally identical custom nodes and
// collapse them into a single canonical definition. Two custom nodes are
// "isomorphic" if, possibly after renaming internal node ids and reordering
// inputs/outputs, they compute the exact same function.

// Build a signature from a circuit: { inputCount, outputCount, bits }.
// bits[o] is an integer whose bits encode the truth table of output o over
// inputCount inputs (in row-major order where input i is bit i).
//
// `definitions` is a Map<defId, def> (engine.definitions) used to recurse into
// nested CUSTOM nodes. It must be provided so that circuits containing custom
// nodes get their TRUE behavior (previously nested customs were treated as 0).
export function buildSignatureForCustom(circuit, definitions) {
  const { nodes, edges } = circuit;
  const inputs = nodes.filter((n) => n.kind === 'input').sort((a, b) => a.inputIndex - b.inputIndex);
  const outputs = nodes.filter((n) => n.kind === 'output').sort((a, b) => a.outputIndex - b.outputIndex);
  const n = inputs.length;
  const rows = 1 << n;
  const bits = new Array(outputs.length).fill(0);

  for (let r = 0; r < rows; r++) {
    const inVals = new Array(n);
    for (let i = 0; i < n; i++) inVals[i] = (r >> i) & 1;
    const out = evaluateCircuit(circuit, inVals, definitions);
    for (let o = 0; o < outputs.length; o++) {
      bits[o] = (bits[o] << 1) | (out[o] ? 1 : 0);
    }
  }
  return { inputCount: n, outputCount: outputs.length, bits };
}

// Canonical string that is identical for any two behaviorally-equivalent
// circuits (up to input/output order, which we deliberately fix by index).
export function canonicalSignature(signature, circuit) {
  const { inputCount, outputCount, bits } = signature;
  return `i${inputCount}:o${outputCount}:${bits.join(',')}`;
}

// Full truth-table evaluation of a circuit (mirrors engine.simulateCircuit),
// recursing into nested CUSTOM nodes via `definitions`.
function evaluateCircuit(circuit, inputValues, definitions) {
  const { nodes, edges } = circuit;
  const byId = new Map();
  nodes.forEach((n) => byId.set(n.id, n));
  const outputs = nodes.filter((n) => n.kind === 'output').sort((a, b) => a.outputIndex - b.outputIndex);

  const deps = new Map();
  edges.forEach((e) => {
    if (!deps.has(e.to)) deps.set(e.to, []);
    deps.get(e.to).push({ from: e.from, port: e.port || 0, srcPort: e.srcPort || 0 });
  });

  const visiting = new Set();
  const values = new Map();
  const multi = new Map();
  const inputs = nodes.filter((n) => n.kind === 'input').sort((a, b) => a.inputIndex - b.inputIndex);
  inputs.forEach((n, i) => values.set(n.id, inputValues[i] | 0));

  // Read a source node's value on a given source port (multi-output aware).
  const readFrom = (srcId, srcPort) => {
    const src = byId.get(srcId);
    if (src && src.kind === 'custom') {
      const bits = multi.has(srcId) ? multi.get(srcId) : evalNode(srcId);
      return (Array.isArray(bits) ? bits : [bits])[srcPort | 0] | 0;
    }
    return evalNode(srcId) | 0;
  };

  const evalNode = (id) => {
    if (values.has(id)) return values.get(id);
    if (multi.has(id)) return multi.get(id)[0] | 0;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const n = byId.get(id);
    let r = 0;
    if (!n) { visiting.delete(id); return 0; }
    if (n.kind === 'input') {
      r = values.get(id) | 0;
    } else if (n.kind === 'nand') {
      const ins = (deps.get(id) || []).slice().sort((a, b) => a.port - b.port);
      const a = ins[0] !== undefined ? readFrom(ins[0].from, ins[0].srcPort) : 0;
      const b = ins[1] !== undefined ? readFrom(ins[1].from, ins[1].srcPort) : 0;
      r = (a && b) ? 0 : 1;
    } else if (n.kind === 'output') {
      const ins = deps.get(id);
      r = ins && ins.length ? readFrom(ins[0].from, ins[0].srcPort) : 0;
    } else if (n.kind === 'custom') {
      // Recurse into the nested definition; resolve its inputs from this
      // circuit's wire map and collect all output bits.
      const inner = definitions ? definitions.get(n.ref) : null;
      if (inner) {
        const innerInputs = (deps.get(id) || []).slice().sort((a, b) => a.port - b.port).map((d) => readFrom(d.from, d.srcPort));
        const bits = evaluateCircuit(inner.circuit, innerInputs, definitions);
        multi.set(id, bits);
        visiting.delete(id);
        return bits[0] | 0;
      }
    }
    visiting.delete(id);
    values.set(id, r);
    return r;
  };

  const result = outputs.map((o) => evalNode(o.id) | 0);
  return result;
}