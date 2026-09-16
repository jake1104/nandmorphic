// Engine: clock-based evaluation with automatic combinational/sequential separation.
// - Combinational logic (no feedback): evaluates immediately when inputs change
// - Sequential logic (feedback loops): only updates on clock edge
// - No PULSE node; INPUT nodes are level-sensitive

import { NodeKind, makeId } from './model.js';
import { buildSignatureForCustom, canonicalSignature } from './optimizer.js';

export const Mode = { DEV: 'dev', RUN: 'run' };

export class Engine {
  constructor() {
    this.definitions = new Map();
    this.nodes = new Map();
    this.position = { x: 0, y: 0 };
    this.version = 0;
    this.mode = Mode.DEV;
    this.clock = 0;           // clock cycle count
    this.clockPhase = 0;      // 0 = low, 1 = high (rising edge = 0->1)
    // analysis caches
    this._analysis = null;    // { sequential: Set(nodeId), combinational: Set(nodeId), order: nodeId[] }
    this._values = new Map(); // nodeId -> 0|1 (current output value)
    this._valuesValid = false; // evaluate() cache flag, cleared by bump()
    this._seqValues = new Map(); // nodeId -> 0|1 (sequential node registered values)
  }

  bump(light = false) {
    this.version++;
    // Positional/value-only edits (drag, toggle, memo/color) keep the
    // topology analysis: Tarjan SCC + topo order is only invalidated by
    // structural edits. This keeps per-frame evaluate() O(n+e) cached.
    if (!light) this._analysis = null;
    this._values.clear();
    this._valuesValid = false;
    // NOTE: _seqValues (latched sequential state) must survive bump().
    // Clearing it here wiped clocked state on every edit AND on every
    // clockStep (which bumps), so sequential circuits never held state.
  }
  bumpLight() { this.bump(true); }

  setMode(m) { this.mode = m; this.bump(); }

  resetClock() {
    this.clock = 0;
    this.clockPhase = 0;
    this._values.clear();
    this._seqValues.clear();
    this.bump();
  }

  addNode(kind, x, y, opts = {}) {
    const id = opts.id && !this.nodes.has(opts.id) ? opts.id
      : makeId(kind === NodeKind.CUSTOM ? 'c' : kind.slice(0, 1));
    let inputCount = 0, outputCount = 0;
    if (opts.inputCount !== undefined) inputCount = opts.inputCount;
    else if (kind === NodeKind.NAND) inputCount = 2;
    else if (kind === NodeKind.OUTPUT) inputCount = 1;
    else if (kind === NodeKind.CUSTOM) {
      const d = this.definitions.get(opts.ref);
      inputCount = d ? d.inputs : 0;
    }
    if (opts.outputCount !== undefined) outputCount = opts.outputCount;
    else if (kind === NodeKind.INPUT) outputCount = 1;
    else if (kind === NodeKind.CONST) outputCount = 1;
    else if (kind === NodeKind.NAND) outputCount = 1;
    else if (kind === NodeKind.CUSTOM) {
      const d = this.definitions.get(opts.ref);
      outputCount = d ? d.outputs : 0;
    }
    const node = {
      id, kind, x, y,
      value: opts.value | 0,
      inputCount, outputCount,
      inputs: new Array(inputCount).fill(null),
      sourcePorts: new Array(inputCount).fill(0),
      inputNames: ensureNames(opts.inputNames, inputCount),
      outputNames: ensureNames(opts.outputNames, outputCount),
      outputs: kind === NodeKind.CUSTOM ? new Array(outputCount).fill(0) : undefined,
      ref: opts.ref || null,
      // displayName for primitives; for CUSTOM this is a per-instance
      // fallback only — shared name lives on the definition (see nameOf()).
      name: opts.name || '',
      // per-instance memo + color (all kinds, including CUSTOM)
      memo: typeof opts.memo === 'string' ? opts.memo.slice(0, 500) : '',
      color: typeof opts.color === 'string' ? opts.color.slice(0, 32) : '',
    };
    this.nodes.set(id, node);
    if (kind === NodeKind.CUSTOM && opts.ref) this.syncCustomInstances(opts.ref);
    this.bump();
    return node;
  }

  removeNode(id) {
    if (!this.nodes.has(id)) return;
    this.nodes.forEach((n) => {
      if (n.inputs) for (let i = 0; i < n.inputs.length; i++) if (n.inputs[i] === id) { n.inputs[i] = null; n.sourcePorts[i] = 0; }
    });
    this.nodes.delete(id);
    this.bump();
  }

  connect(srcId, dstId, portIndex, srcPort = 0) {
    const src = this.nodes.get(srcId);
    const dst = this.nodes.get(dstId);
    if (!src || !dst) return false;
    if (srcId === dstId) return false;
    if (this.outputCountOf(src) <= srcPort) return false;
    if (!dst.inputs || portIndex < 0 || portIndex >= this.inputCountOf(dst)) return false;
    dst.inputs[portIndex] = srcId;
    dst.sourcePorts[portIndex] = srcPort;
    this.bump();
    return true;
  }
  disconnect(dstId, portIndex) {
    const dst = this.nodes.get(dstId);
    if (!dst || !dst.inputs) return;
    if (portIndex >= 0 && portIndex < dst.inputs.length) {
      dst.inputs[portIndex] = null;
      dst.sourcePorts[portIndex] = 0;
      this.bump();
    }
  }
  toggleInput(id) {
    const n = this.nodes.get(id);
    if (n && n.kind === NodeKind.INPUT) {
      n.value = n.value ? 0 : 1;
      this.bumpLight();
    }
  }
  // CONST toggles only in dev(edit) mode; locked in run mode.
  toggleConst(id) {
    const n = this.nodes.get(id);
    if (!n || n.kind !== NodeKind.CONST) return false;
    if (this.mode !== Mode.DEV) return false;
    n.value = n.value ? 0 : 1;
    this.bumpLight();
    return true;
  }
  setNodeMemo(nodeId, memo) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    n.memo = String(memo || '').slice(0, 500);
    this.bumpLight();
  }
  setNodeColor(nodeId, color) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    n.color = String(color || '').slice(0, 32);
    this.bumpLight();
  }
  // ---- Shared CUSTOM info: single source of truth = definitions ----
  customDefOf(node) {
    if (!node || node.kind !== NodeKind.CUSTOM) return null;
    return this.definitions.get(node.ref) || null;
  }
  inputCountOf(node) {
    if (!node) return 0;
    if (node.kind === NodeKind.CUSTOM) {
      const d = this.definitions.get(node.ref);
      return d ? d.inputs : 0;
    }
    return node.inputCount | 0;
  }
  outputCountOf(node) {
    if (!node) return 0;
    if (node.kind === NodeKind.CUSTOM) {
      const d = this.definitions.get(node.ref);
      return d ? d.outputs : 0;
    }
    return node.outputCount | 0;
  }
  nameOf(node) {
    if (!node) return '';
    if (node.kind === NodeKind.CUSTOM) {
      const d = this.definitions.get(node.ref);
      if (d) return d.name || node.name || '';
    }
    return node.name || '';
  }
  inputNameOf(node, i) {
    if (!node) return '';
    if (node.kind === NodeKind.CUSTOM) {
      const d = this.definitions.get(node.ref);
      const list = (d && d.circuit && d.circuit.ports && d.circuit.ports.inputs) || [];
      return list[i] || '';
    }
    return (node.inputNames && node.inputNames[i]) || '';
  }
  outputNameOf(node, i) {
    if (!node) return '';
    if (node.kind === NodeKind.CUSTOM) {
      const d = this.definitions.get(node.ref);
      const list = (d && d.circuit && d.circuit.ports && d.circuit.ports.outputs) || [];
      return list[i] || '';
    }
    return (node.outputNames && node.outputNames[i]) || '';
  }
  // Mirror shared definition state into each instance's cached fields so
  // geometry (ports.js) and old serialized data keep working. Cached fields
  // are never edited directly for CUSTOM — use setShared* below.
  syncCustomInstances(defId) {
    const def = this.definitions.get(defId);
    if (!def) return;
    const inNames = ((def.circuit && def.circuit.ports && def.circuit.ports.inputs) || []).slice();
    const outNames = ((def.circuit && def.circuit.ports && def.circuit.ports.outputs) || []).slice();
    this.nodes.forEach((n) => {
      if (n.kind !== NodeKind.CUSTOM || n.ref !== defId) return;
      n.inputCount = def.inputs;
      n.outputCount = def.outputs;
      n.name = def.name || '';
      n.inputNames = ensureNames(inNames, def.inputs);
      n.outputNames = ensureNames(outNames, def.outputs);
      const oldIn = n.inputs || [];
      const oldSp = n.sourcePorts || [];
      n.inputs = new Array(def.inputs).fill(null);
      n.sourcePorts = new Array(def.inputs).fill(0);
      for (let i = 0; i < Math.min(oldIn.length, def.inputs); i++) {
        n.inputs[i] = oldIn[i];
        n.sourcePorts[i] = oldSp[i] | 0;
      }
      n.outputs = new Array(def.outputs).fill(0);
    });
  }
  setSharedName(defId, name) {
    const def = this.definitions.get(defId);
    if (!def) return false;
    def.name = String(name || '').slice(0, 24);
    this.syncCustomInstances(defId);
    this.bump();
    return true;
  }
  setSharedPortName(defId, dir, port, name) {
    const def = this.definitions.get(defId);
    if (!def || !def.circuit || !def.circuit.ports) return false;
    const list = dir === 'in' ? def.circuit.ports.inputs : def.circuit.ports.outputs;
    if (!list || port < 0 || port >= list.length) return false;
    const trimmed = String(name || '').slice(0, 16);
    list[port] = trimmed;
    // Two-way sync (#4): the internal INPUT/OUTPUT node carrying this port
    // follows the shared name, so "definition port name" and "internal I/O
    // node name" never diverge.
    for (const cn of def.circuit.nodes || []) {
      if (dir === 'in' && cn.kind === 'input' && (cn.inputIndex | 0) === port) cn.name = trimmed;
      if (dir === 'out' && cn.kind === 'output' && (cn.outputIndex | 0) === port) cn.name = trimmed;
    }
    this.syncCustomInstances(defId);
    this.bump();
    return true;
  }
  setPortName(nodeId, dir, port, name) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    // I/O nodes expose their name as the port itself (#5): no separate
    // port-name editing for INPUT outputs / OUTPUT inputs.
    if (n.kind === NodeKind.INPUT && dir === 'out') return;
    if (n.kind === NodeKind.OUTPUT && dir === 'in') return;
    if (n.kind === NodeKind.CUSTOM) {
      this.setSharedPortName(n.ref, dir, port, name);
      return;
    }
    const arr = dir === 'in' ? n.inputNames : n.outputNames;
    if (port < 0 || port >= arr.length) return;
    arr[port] = String(name || '').slice(0, 16);
    this.bump();
  }
  setNodeName(nodeId, name) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    if (n.kind === NodeKind.CUSTOM) {
      this.setSharedName(n.ref, name);
      return;
    }
    n.name = String(name || '').slice(0, 24);
    this.bump();
  }
  // Swap two ports of a node, keeping wiring attached to the moved entries.
  // dir 'in': swaps inputNames/inputs/sourcePorts entries.
  // dir 'out': swaps outputNames/outputs entries and remaps every downstream
  // wire's sourcePorts so wires follow their source output.
  swapNodePorts(nodeId, dir, i, j) {
    const n = this.nodes.get(nodeId);
    if (!n || i === j) return false;
    // CUSTOM ports are shared: reorder the definition once, then remap
    // every instance of the same kind so all stay in sync.
    if (n.kind === NodeKind.CUSTOM) {
      const def = this.definitions.get(n.ref);
      if (!def || !def.circuit || !def.circuit.ports) return false;
      if (dir === 'in') {
        const names = def.circuit.ports.inputs;
        if (i < 0 || j < 0 || i >= names.length || j >= names.length) return false;
        [names[i], names[j]] = [names[j], names[i]];
        // remap internal INPUT nodes' port order markers (inputIndex)
        (def.circuit.nodes || []).forEach((cn) => {
          if (cn.kind === 'input') {
            if (cn.inputIndex === i) cn.inputIndex = j;
            else if (cn.inputIndex === j) cn.inputIndex = i;
          }
        });
        this.nodes.forEach((m) => {
          if (m.kind === NodeKind.CUSTOM && m.ref === n.ref && m.inputs) {
            [m.inputs[i], m.inputs[j]] = [m.inputs[j], m.inputs[i]];
            [m.sourcePorts[i], m.sourcePorts[j]] = [m.sourcePorts[j], m.sourcePorts[i]];
          }
        });
        this.syncCustomInstances(n.ref);
        this.bump();
        return true;
      }
      const names = def.circuit.ports.outputs;
      if (i < 0 || j < 0 || i >= names.length || j >= names.length) return false;
      [names[i], names[j]] = [names[j], names[i]];
      (def.circuit.nodes || []).forEach((cn) => {
        if (cn.kind === 'output') {
          if (cn.outputIndex === i) cn.outputIndex = j;
          else if (cn.outputIndex === j) cn.outputIndex = i;
        }
      });
      this.nodes.forEach((m) => {
        if (!m.inputs) return;
        for (let k = 0; k < m.inputs.length; k++) {
          if (m.inputs[k] && this.nodes.get(m.inputs[k])?.kind === NodeKind.CUSTOM && this.nodes.get(m.inputs[k]).ref === n.ref) {
            if (m.sourcePorts[k] === i) m.sourcePorts[k] = j;
            else if (m.sourcePorts[k] === j) m.sourcePorts[k] = i;
          }
        }
      });
      // remap stored definition edges' srcPort for this kind
      this.definitions.forEach((d) => {
        (d.circuit.edges || []).forEach((e) => {
          const src = (d.circuit.nodes || []).find((cn) => cn.id === e.from);
          if (src && src.kind === 'custom' && src.ref === n.ref) {
            if (e.srcPort === i) e.srcPort = j;
            else if (e.srcPort === j) e.srcPort = i;
          }
        });
      });
      this.syncCustomInstances(n.ref);
      this.bump();
      return true;
    }
    if (dir === 'in') {
      if (!n.inputs || i < 0 || j < 0 || i >= n.inputs.length || j >= n.inputs.length) return false;
      [n.inputNames[i], n.inputNames[j]] = [n.inputNames[j], n.inputNames[i]];
      [n.inputs[i], n.inputs[j]] = [n.inputs[j], n.inputs[i]];
      [n.sourcePorts[i], n.sourcePorts[j]] = [n.sourcePorts[j], n.sourcePorts[i]];
    } else {
      if (!n.outputNames || i < 0 || j < 0 || i >= n.outputNames.length || j >= n.outputNames.length) return false;
      [n.outputNames[i], n.outputNames[j]] = [n.outputNames[j], n.outputNames[i]];
      if (n.outputs) [n.outputs[i], n.outputs[j]] = [n.outputs[j], n.outputs[i]];
      this.nodes.forEach((m) => {
        if (!m.inputs) return;
        for (let k = 0; k < m.inputs.length; k++) {
          if (m.inputs[k] === nodeId) {
            if (m.sourcePorts[k] === i) m.sourcePorts[k] = j;
            else if (m.sourcePorts[k] === j) m.sourcePorts[k] = i;
          }
        }
      });
    }
    this.bump();
    return true;
  }
  // Reorder a definition's ports to `newOrder` (array of old indices in the
  // new order, e.g. [2,0,1]). Shared kind-level reorder used by both the
  // node inspector and the library settings modal, so a drag-reordered port
  // list is persisted to the definition itself (#3).
  reorderDefinitionPorts(defId, dir, newOrder) {
    const def = this.definitions.get(defId);
    if (!def || !def.circuit || !def.circuit.ports) return false;
    const names = dir === 'in' ? def.circuit.ports.inputs : def.circuit.ports.outputs;
    if (!names || !Array.isArray(newOrder) || newOrder.length !== names.length) return false;
    const seen = new Set(newOrder);
    if (seen.size !== names.length) return false;
    for (const k of newOrder) if (!Number.isInteger(k) || k < 0 || k >= names.length) return false;
    if (newOrder.every((o, k) => o === k)) return true; // noop, already in order
    const reordered = newOrder.map((k) => names[k]);
    for (let k = 0; k < names.length; k++) names[k] = reordered[k];
    const oldToNew = new Array(names.length);
    newOrder.forEach((old, k) => { oldToNew[old] = k; });
    if (dir === 'in') {
      (def.circuit.nodes || []).forEach((cn) => {
        if (cn.kind === 'input' && Number.isInteger(cn.inputIndex)) cn.inputIndex = oldToNew[cn.inputIndex] ?? cn.inputIndex;
      });
      this.nodes.forEach((m) => {
        if (m.kind !== NodeKind.CUSTOM || m.ref !== defId || !m.inputs) return;
        m.inputs = newOrder.map((o) => m.inputs[o]);
        m.sourcePorts = newOrder.map((o) => m.sourcePorts[o]);
      });
    } else {
      (def.circuit.nodes || []).forEach((cn) => {
        if (cn.kind === 'output' && Number.isInteger(cn.outputIndex)) cn.outputIndex = oldToNew[cn.outputIndex] ?? cn.outputIndex;
      });
      this.nodes.forEach((m) => {
        if (!m.inputs) return;
        for (let k = 0; k < m.inputs.length; k++) {
          const src = m.inputs[k] ? this.nodes.get(m.inputs[k]) : null;
          if (src && src.kind === NodeKind.CUSTOM && src.ref === defId) {
            m.sourcePorts[k] = oldToNew[m.sourcePorts[k]] ?? m.sourcePorts[k];
          }
        }
      });
      this.definitions.forEach((d) => {
        (d.circuit.edges || []).forEach((e) => {
          const src = (d.circuit.nodes || []).find((cn) => cn.id === e.from);
          if (src && src.kind === 'custom' && src.ref === defId) {
            e.srcPort = oldToNew[e.srcPort] ?? e.srcPort;
          }
        });
      });
    }
    this.syncCustomInstances(defId);
    this.bump();
    return true;
  }
  // Move a definition up (dir=-1) or down (dir=+1) in library order.
  moveDefinition(defId, dir) {
    const ids = Array.from(this.definitions.keys());
    const i = ids.indexOf(defId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return false;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const rebuilt = new Map();
    for (const id of ids) rebuilt.set(id, this.definitions.get(id));
    this.definitions = rebuilt;
    this.bump();
    return true;
  }
  // Reorder the definitions map to match the given id order (for drag reorder).
  reorderDefinitions(ids) {
    const rebuilt = new Map();
    for (const id of ids) {
      const d = this.definitions.get(id);
      if (d) rebuilt.set(id, d);
    }
    for (const [id, d] of this.definitions) if (!rebuilt.has(id)) rebuilt.set(id, d);
    if (rebuilt.size !== this.definitions.size) return false;
    this.definitions = rebuilt;
    this.bump();
    return true;
  }

  // ---- Clock-based evaluation ----
  // Build dependency graph and find feedback loops (SCCs with cycles)
  analyzeCircuit() {
    if (this._analysis) return this._analysis;

    const nodes = this.getNodes();
    const nodeIds = nodes.map(n => n.id);
    const idToIndex = new Map(nodeIds.map((id, i) => [id, i]));
    const n = nodeIds.length;
    const adj = new Array(n).fill(0).map(() => []);

    // Build adjacency: src -> dst (following signal flow)
    for (const node of nodes) {
      if (!node.inputs) continue;
      const u = idToIndex.get(node.id);
      for (let i = 0; i < node.inputs.length; i++) {
        const srcId = node.inputs[i];
        if (!srcId) continue;
        const v = idToIndex.get(srcId);
        if (v !== undefined) adj[v].push(u);
      }
    }

    // Tarjan's algorithm for SCCs
    const index = new Array(n).fill(-1);
    const lowlink = new Array(n).fill(0);
    const onStack = new Array(n).fill(false);
    const stack = [];
    let idx = 0;
    const sccs = [];

    function strongconnect(v) {
      index[v] = lowlink[v] = idx++;
      stack.push(v);
      onStack[v] = true;
      for (const w of adj[v]) {
        if (index[w] === -1) {
          strongconnect(w);
          lowlink[v] = Math.min(lowlink[v], lowlink[w]);
        } else if (onStack[w]) {
          lowlink[v] = Math.min(lowlink[v], index[w]);
        }
      }
      if (lowlink[v] === index[v]) {
        const scc = [];
        let w;
        do {
          w = stack.pop();
          onStack[w] = false;
          scc.push(w);
        } while (w !== v);
        sccs.push(scc);
      }
    }

    for (let v = 0; v < n; v++) if (index[v] === -1) strongconnect(v);

    // Nodes in SCCs of size > 1, or size 1 with self-loop = sequential
    const sequential = new Set();
    for (const scc of sccs) {
      if (scc.length > 1) {
        for (const v of scc) sequential.add(nodeIds[v]);
      } else if (scc.length === 1) {
        const v = scc[0];
        // check self-loop
        if (adj[v].includes(v)) sequential.add(nodeIds[v]);
      }
    }

    // Combinational = all others
    const combinational = new Set();
    for (const id of nodeIds) if (!sequential.has(id)) combinational.add(id);

    // Topological order for combinational nodes (for immediate propagation)
    const comboAdj = new Map();
    const indeg = new Map();
    for (const id of combinational) { comboAdj.set(id, []); indeg.set(id, 0); }
    for (const node of nodes) {
      if (!combinational.has(node.id)) continue;
      if (!node.inputs) continue;
      for (const srcId of node.inputs) {
        if (!srcId) continue;
        if (combinational.has(srcId)) {
          comboAdj.get(srcId).push(node.id);
          indeg.set(node.id, (indeg.get(node.id) || 0) + 1);
        }
      }
    }
    // Kahn's algorithm
    const queue = [];
    for (const [id, deg] of indeg) if (deg === 0) queue.push(id);
    const order = [];
    while (queue.length) {
      const u = queue.shift();
      order.push(u);
      for (const v of comboAdj.get(u) || []) {
        const d = indeg.get(v) - 1;
        indeg.set(v, d);
        if (d === 0) queue.push(v);
      }
    }
    // Remaining nodes have cycles within combinational (shouldn't happen if analysis correct)
    for (const [id, deg] of indeg) if (deg > 0) order.push(id);

    this._analysis = { sequential, combinational, order };
    return this._analysis;
  }

  // Read one input bit of a node, following the source port when the source
  // is a multi-output CUSTOM node.
  readInputBit(node, p, values) {
    const srcId = node.inputs?.[p];
    if (!srcId) return 0;
    const sp = (node.sourcePorts && node.sourcePorts[p]) | 0;
    const src = this.nodes.get(srcId);
    if (src && src.kind === NodeKind.CUSTOM) {
      const outs = values.get(srcId);
      return (Array.isArray(outs) ? (outs[sp] | 0) : 0);
    }
    return (values.get(srcId) | 0);
  }

  // Evaluate a single node's output given current input values
  evalNode(node, values) {
    switch (node.kind) {
      case NodeKind.INPUT:
      case NodeKind.CONST:
        return node.value | 0;
      case NodeKind.OUTPUT: {
        return this.readInputBit(node, 0, values);
      }
      case NodeKind.NAND: {
        const a = this.readInputBit(node, 0, values);
        const b = this.readInputBit(node, 1, values);
        return (a && b) ? 0 : 1;
      }
      case NodeKind.CUSTOM: {
        // Custom nodes evaluate live: simulate their definition with the
        // current input bits. Returns an array of output bits (one per port).
        return this.evaluateCustomLive(node, values);
      }
      default:
        return 0;
    }
  }

  // Combinational evaluation: propagate through combinational nodes in topo order
  evalCombinational(values) {
    const { combinational, order } = this.analyzeCircuit();
    for (const id of order) {
      if (!combinational.has(id)) continue;
      const node = this.nodes.get(id);
      if (!node) continue;
      const out = this.evalNode(node, values);
      values.set(id, out);
    }
    return values;
  }

  // Sequential evaluation on clock edge.
  // - Loops with a stable state (latches) iterate to a fixpoint so the
  //   latched result doesn't depend on node order.
  // - Loops with no stable state (odd-inversion rings) can never converge:
  //   fall back to one synchronous step from the frozen pre-edge state so
  //   oscillators advance deterministically instead of freezing.
  evalSequential() {
    const { sequential } = this.analyzeCircuit();
    if (sequential.size === 0) return;
    // Frozen pre-edge state: current values + latched sequential values.
    const pre = new Map(this._values);
    for (const [id, v] of this._seqValues) pre.set(id, v);
    const next = new Map(this._seqValues);
    const view = new Map(pre);
    let converged = false;
    for (let pass = 0; pass < 16 && !converged; pass++) {
      converged = true;
      for (const id of sequential) {
        const node = this.nodes.get(id);
        if (!node) continue;
        const out = this.evalNode(node, view);
        if (!seqEqual(next.get(id), out)) {
          next.set(id, out);
          view.set(id, out);
          converged = false;
        }
      }
    }
    if (!converged) {
      next.clear();
      for (const id of sequential) {
        const node = this.nodes.get(id);
        if (!node) continue;
        next.set(id, this.evalNode(node, pre));
      }
    }
    this._seqValues = next;
    // Update main values with new sequential outputs
    for (const [id, val] of this._seqValues) {
      this._values.set(id, val);
    }
  }

  // Full evaluation: sequential (on clock edge) -> combinational propagation.
  // Result is cached until the next bump(): draw(), hover checks and overlay
  // drawing all call evaluate() every frame, so recomputing Tarjan + custom
  // simulation per call was the main per-frame cost (#2).
  evaluate() {
    if (this._valuesValid) return this._values;
    this._values.clear();
    // Initialize values from INPUT/CONST nodes
    for (const node of this.getNodes()) {
      if (node.kind === NodeKind.INPUT || node.kind === NodeKind.CONST) {
        this._values.set(node.id, node.value | 0);
      }
    }
    // Sequential nodes use registered values
    for (const [id, val] of this._seqValues) {
      this._values.set(id, val);
    }
    // Propagate combinational
    this.evalCombinational(this._values);
    this._valuesValid = true;
    return this._values;
  }

  // Advance clock: rising edge triggers sequential update
  clockStep() {
    // Rising edge: 0 -> 1
    if (this.clockPhase === 0) {
      this.clockPhase = 1;
      this.evaluate(); // settle current combinational state first so the
                       // edge latches settled inputs, not a stale _values map
      this.evalSequential();
      this.evalCombinational(this._values);
    } else {
      // Falling edge: 1 -> 0, just advance clock
      this.clockPhase = 0;
      this.clock++;
    }
    this.bumpLight();
    return this.clock;
  }

  // For RUN mode: auto-advance clock
  tickStep() {
    return this.clockStep();
  }

  // evaluateCustom for optimizer (combinational simulation)
  evaluateCustom(instance) {
    return this.evaluateCustomLive(instance, this._values);
  }
  // Live evaluation of a CUSTOM instance against an arbitrary values map.
  // Input bits are read port-aware; nested CUSTOM sources inside the
  // definition are resolved recursively with source ports honored.
  evaluateCustomLive(instance, values) {
    const def = this.definitions.get(instance.ref);
    if (!def) return new Array(this.outputCountOf(instance)).fill(0);
    const inputValues = [];
    for (let p = 0; p < this.inputCountOf(instance); p++) {
      inputValues.push(this.readInputBit(instance, p, values));
    }
    const bits = this.simulateDefinition(def, inputValues);
    // Pad to the instance's output count in case the def was deduped.
    const expected = this.outputCountOf(instance) || bits.length;
    while (bits.length < expected) bits.push(0);
    // Keep the renderer's snapshot fresh.
    instance.outputs = bits.slice();
    return bits;
  }
  simulateDefinition(def, inputValues) { return simulateCircuit(def, this, inputValues); }

  registerDefinition(circuit, name) {
    // Truth-table dedup is 2^n simulations: beyond ~12 inputs a save would
    // hang for minutes (#2). Large circuits skip behavioral dedup and always
    // allocate a fresh definition.
    const probeInputs = (circuit.nodes || []).filter((n) => n.kind === 'input').length;
    if (probeInputs > 12) {
      const probeOutputs = (circuit.nodes || []).filter((n) => n.kind === 'output').length;
      return this.createDefinition(circuit, name,
        { inputCount: probeInputs, outputCount: probeOutputs, bits: [], approx: true },
        `unique:${makeId('big')}`);
    }
    const signature = buildSignatureForCustom(circuit, this.definitions);
    const canon = canonicalSignature(signature, circuit);
    for (const [, def] of this.definitions) if (def.canonical === canon) return def;
    return this.createDefinition(circuit, name, signature, canon);
  }
  // Always allocate a new definition id for `circuit` (no dedup).
  createDefinition(circuit, name, signature, canon) {
    const sig = signature || buildSignatureForCustom(circuit, this.definitions);
    const canonical = canon || canonicalSignature(sig, circuit);
    const ticks = computeTicksForCircuit(circuit, this.definitions);
    const def = { id: makeId('def'), name: name || 'custom', signature: sig, canonical, inputs: sig.inputCount, outputs: sig.outputCount, circuit, ticks };
    this.definitions.set(def.id, def);
    this.bump();
    return def;
  }
  // Replace a definition's stored circuit wholesale (structure + layout) and
  // recompute its derived data. Used when committing edits whose behavior is
  // unchanged but whose structure differs — merging into the old circuit
  // would silently drop added nodes, rewires, renames, etc.
  replaceDefinitionCircuit(defId, circuit) {
    const def = this.definitions.get(defId);
    if (!def) return null;
    const signature = buildSignatureForCustom(circuit, this.definitions);
    def.circuit = circuit;
    def.signature = signature;
    def.canonical = canonicalSignature(signature, circuit);
    def.inputs = signature.inputCount;
    def.outputs = signature.outputCount;
    def.ticks = computeTicksForCircuit(circuit, this.definitions);
    this.syncCustomInstances(defId);
    this.bump();
    return def;
  }
  instantiate(def, x, y) {
    return this.addNode(NodeKind.CUSTOM, x, y, { ref: def.id, name: def.name, inputNames: portNamesOfDef(def, 'in'), outputNames: portNamesOfDef(def, 'out') });
  }
  // Overwrite a definition's stored node positions with the layout of `circuit`.
  // Used when committing edited internals, because registerDefinition may dedupe
  // to an existing definition (positions aren't part of the behavioral
  // signature) and would otherwise keep the old layout.
  setDefinitionLayout(defId, circuit) {
    const def = this.definitions.get(defId);
    if (!def || !def.circuit || !circuit || !circuit.nodes) return false;
    const byId = new Map(circuit.nodes.map((n) => [n.id, n]));
    for (const cn of def.circuit.nodes) {
      const m = byId.get(cn.id);
      if (m && Number.isFinite(m.x) && Number.isFinite(m.y)) {
        cn.x = m.x;
        cn.y = m.y;
      }
    }
    this.bumpLight();
    return true;
  }
  getNodes() { return Array.from(this.nodes.values()); }
  getDefinitions() { return Array.from(this.definitions.values()); }

  expandDefinition(def) {
    this.nodes = new Map();
    this.clock = 0;
    this.clockPhase = 0;
    this._analysis = null;
    this._values.clear();
    this._seqValues.clear();
    const circuit = def.circuit || { nodes: [], edges: [] };
    const pos = layoutCircuit(circuit);
    for (const cn of circuit.nodes) {
      const laid = pos.get(cn.id) || { x: 160 + Math.random() * 40, y: 160 + Math.random() * 40 };
      const p = (Number.isFinite(cn.x) && Number.isFinite(cn.y)) ? { x: cn.x, y: cn.y } : laid;
      if (cn.kind === 'input') this.addNode(NodeKind.INPUT, p.x, p.y, { id: cn.id, value: cn.value | 0, name: cn.name || '', memo: cn.memo || '', color: cn.color || '' });
      else if (cn.kind === 'const') this.addNode(NodeKind.CONST, p.x, p.y, { id: cn.id, value: cn.value | 0, name: cn.name || '', memo: cn.memo || '', color: cn.color || '' });
      else if (cn.kind === 'output') this.addNode(NodeKind.OUTPUT, p.x, p.y, { id: cn.id, name: cn.name || '', memo: cn.memo || '', color: cn.color || '' });
      else if (cn.kind === 'nand') this.addNode(NodeKind.NAND, p.x, p.y, { id: cn.id, name: cn.name || '', memo: cn.memo || '', color: cn.color || '' });
      else if (cn.kind === 'custom') {
        if (!this.definitions.get(cn.ref)) continue;
        this.addNode(NodeKind.CUSTOM, p.x, p.y, { id: cn.id, ref: cn.ref, memo: cn.memo || '', color: cn.color || '' });
      }
    }
    for (const e of circuit.edges) {
      const src = this.nodes.get(e.from);
      const dst = this.nodes.get(e.to);
      if (!src || !dst) continue;
      this.connect(e.from, e.to, e.port || 0, e.srcPort || 0);
    }
    this.bump();
  }
  repointInstance(instanceId, def) {
    const n = this.nodes.get(instanceId);
    if (!n || n.kind !== NodeKind.CUSTOM) return;
    n.ref = def.id;
    this.syncCustomInstances(def.id);
    // preserve per-instance wiring as far as possible (sync already truncates)
    this.bump();
  }
  repointAllInstances(defId, newDef) {
    const ids = [];
    this.nodes.forEach((n) => { if (n.kind === NodeKind.CUSTOM && n.ref === defId) ids.push(n.id); });
    ids.forEach((id) => this.repointInstance(id, newDef));
  }
  removeDefinition(id) {
    if (!this.definitions.has(id)) return;
    this.definitions.delete(id);
    const toRemove = [];
    this.nodes.forEach((n) => { if (n.kind === NodeKind.CUSTOM && n.ref === id) toRemove.push(n.id); });
    toRemove.forEach((nid) => this.removeNode(nid));
    this.bump();
  }
  dependencyGraph() {
    const g = new Map();
    this.definitions.forEach((def) => {
      const used = new Set();
      (def.circuit && def.circuit.nodes || []).forEach((n) => { if (n.kind === 'custom' && n.ref && this.definitions.has(n.ref)) used.add(n.ref); });
      g.set(def.id, used);
    });
    return g;
  }
  wouldCreateCycle(containerDefId, insertDefId) {
    if (containerDefId === insertDefId) return true;
    const g = this.dependencyGraph();
    const stack = [insertDefId]; const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue; seen.add(cur);
      if (cur === containerDefId) return true;
      const kids = g.get(cur);
      if (kids) kids.forEach((k) => stack.push(k));
    }
    return false;
  }
  insertableDefinitions(containerDefId) {
    return Array.from(this.definitions.values()).filter((d) => !this.wouldCreateCycle(containerDefId, d.id));
  }

  toJSON() {
    return {
      version: 5,
      mode: this.mode,
      clock: this.clock,
      definitions: Array.from(this.definitions.values()),
      nodes: Array.from(this.nodes.values()).map((n) => ({
        id: n.id, kind: n.kind, x: n.x, y: n.y, value: n.value, inputs: n.inputs || [], inputCount: n.inputCount, outputCount: n.outputCount, sourcePorts: n.sourcePorts || [], inputNames: n.inputNames || [], outputNames: n.outputNames || [], ref: n.ref, name: n.name, memo: n.memo || '', color: n.color || '',
      })),
    };
  }
  fromJSON(data) {
    this.definitions = new Map();
    this.nodes = new Map();
    this.mode = data.mode || Mode.DEV;
    this.clock = data.clock | 0;
    this.clockPhase = 0;
    this._analysis = null;
    this._values.clear();
    this._seqValues.clear();
    (data.definitions || []).forEach((d) => {
      const circuit = d.circuit || { nodes: [], edges: [] };
      if (d.ticks === undefined) d.ticks = computeTicksForCircuit(circuit, this.definitions);
      this.definitions.set(d.id, { ...d, circuit });
    });
    this.definitions.forEach((d) => { if (d.ticks === undefined) d.ticks = computeTicksForCircuit(d.circuit, this.definitions); });
    (data.nodes || []).forEach((n) => {
      const def = n.ref ? this.definitions.get(n.ref) : null;
      let inputCount = n.inputCount;
      let outputCount = n.outputCount;
      if (inputCount === undefined) {
        if (n.kind === NodeKind.NAND) inputCount = 2;
        else if (n.kind === NodeKind.OUTPUT) inputCount = 1;
        else if (n.kind === NodeKind.CUSTOM) inputCount = def ? def.inputs : 0;
        else inputCount = 0;
      }
      if (outputCount === undefined) {
        if (n.kind === NodeKind.INPUT) outputCount = 1;
        else if (n.kind === NodeKind.CONST) outputCount = 1;
        else if (n.kind === NodeKind.NAND) outputCount = 1;
        else if (n.kind === NodeKind.CUSTOM) outputCount = def ? def.outputs : 0;
        else outputCount = 0;
      }
      // CUSTOM shared info wins over stored copies (old files may diverge).
      if (n.kind === NodeKind.CUSTOM && def) {
        inputCount = def.inputs;
        outputCount = def.outputs;
      }
      this.nodes.set(n.id, {
        id: n.id, kind: n.kind, x: n.x, y: n.y, value: n.value | 0,
        inputs: (n.inputs && n.inputs.length === inputCount) ? n.inputs : new Array(inputCount).fill(null),
        sourcePorts: (n.sourcePorts && n.sourcePorts.length === inputCount) ? n.sourcePorts : new Array(inputCount).fill(0),
        inputCount, outputCount,
        inputNames: n.kind === NodeKind.CUSTOM && def ? portNamesOfDef(def, 'in') : ensureNames(n.inputNames, inputCount),
        outputNames: n.kind === NodeKind.CUSTOM && def ? portNamesOfDef(def, 'out') : ensureNames(n.outputNames, outputCount),
        outputs: n.kind === NodeKind.CUSTOM ? new Array(outputCount).fill(0) : undefined,
        ref: n.ref, name: n.kind === NodeKind.CUSTOM && def ? (def.name || '') : (n.name || ''),
        memo: typeof n.memo === 'string' ? n.memo.slice(0, 500) : '',
        color: typeof n.color === 'string' ? n.color.slice(0, 32) : '',
      });
    });
    this.bump();
  }
}

function ensureNames(arr, n) {
  const a = (arr && arr.length === n) ? arr.slice() : new Array(n).fill('');
  while (a.length < n) a.push(''); return a;
}

// Sequential latch values may be scalars (0|1) or arrays (CUSTOM multi-out).
// A missing latch (undefined) is never equal to a computed value —
// otherwise a node whose next state is 0 would never get latched.
function seqEqual(a, b) {
  if (a === undefined || b === undefined) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : [a];
    const y = Array.isArray(b) ? b : [b];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if ((x[i] | 0) !== (y[i] | 0)) return false;
    return true;
  }
  return (a | 0) === (b | 0);
}

// Compare two definition circuits structurally, ignoring node positions.
// Used on commit: behavior-only dedup must not discard structural edits
// (added/removed nodes, rewired edges, renames, port changes, input values).
export function sameCircuitStructure(a, b) {
  const strip = (c) => {
    const nodes = ((c && c.nodes) || []).map((n) => ({
      id: n.id, kind: n.kind,
      inputIndex: n.inputIndex | 0, outputIndex: n.outputIndex | 0,
      ref: n.ref || null, name: n.name || '', value: n.value | 0,
    })).sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
    const edges = ((c && c.edges) || []).map((e) => ({
      from: e.from, to: e.to, port: e.port | 0, srcPort: e.srcPort | 0,
    })).sort((p, q) => {
      const s = `${p.from}>${p.to}:${p.port}:${p.srcPort}`;
      const t = `${q.from}>${q.to}:${q.port}:${q.srcPort}`;
      return s < t ? -1 : s > t ? 1 : 0;
    });
    const ports = (c && c.ports) || { inputs: [], outputs: [] };
    return { nodes, edges, ports: { inputs: ports.inputs || [], outputs: ports.outputs || [] } };
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

// Keep a definition's port order stable across commits (#3). Internal node
// ids survive expand/commit round-trips, so ports of retained INPUT/OUTPUT
// nodes follow the old definition's order; newly added nodes append at the end.
export function preservePortOrder(oldCircuit, newCircuit) {
  if (!oldCircuit || !newCircuit || !newCircuit.ports) return;
  for (const kind of ['input', 'output']) {
    const idxKey = kind === 'input' ? 'inputIndex' : 'outputIndex';
    const ports = kind === 'input' ? newCircuit.ports.inputs : newCircuit.ports.outputs;
    if (!ports) continue;
    const oldNodes = (oldCircuit.nodes || [])
      .filter((n) => n.kind === kind)
      .sort((a, b) => ((a[idxKey] | 0) - (b[idxKey] | 0)));
    const oldPos = new Map(oldNodes.map((n, k) => [n.id, k]));
    const news = (newCircuit.nodes || []).filter((n) => n.kind === kind);
    const nameById = new Map();
    for (const nd of news) nameById.set(nd.id, ports[nd[idxKey] | 0] ?? '');
    news.sort((a, b) => {
      const oa = oldPos.has(a.id) ? oldPos.get(a.id) : 1e9;
      const ob = oldPos.has(b.id) ? oldPos.get(b.id) : 1e9;
      if (oa !== ob) return oa - ob;
      return ((a[idxKey] | 0) - (b[idxKey] | 0));
    });
    news.forEach((nd, k) => { nd[idxKey] = k; ports[k] = nameById.get(nd.id) ?? ''; });
  }
}

function portNamesOfDef(def, dir) {
  const ports = (def.circuit && def.circuit.ports) || null;
  if (!ports) return new Array(dir === 'in' ? def.inputs : def.outputs).fill('');
  const list = dir === 'in' ? ports.inputs : ports.outputs;
  return new Array(dir === 'in' ? def.inputs : def.outputs).fill('').map((_, i) => (list && list[i]) || '');
}

function layoutCircuit(circuit) {
  const { nodes, edges } = circuit;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const deps = new Map();
  edges.forEach((e) => { if (!deps.has(e.to)) deps.set(e.to, []); deps.get(e.to).push(e.from); });
  const depth = new Map();
  const visit = (id) => {
    if (depth.has(id)) return depth.get(id);
    const n = byId.get(id);
    if (!n || n.kind === 'input') { depth.set(id, 0); return 0; }
    let d = 0;
    for (const s of deps.get(id) || []) d = Math.max(d, visit(s) + 1);
    depth.set(id, d); return d;
  };
  nodes.forEach((n) => visit(n.id));
  let maxD = 0; depth.forEach((d) => { maxD = Math.max(maxD, d); });
  const groups = new Map();
  nodes.forEach((n) => {
    const d = n.kind === 'output' ? maxD + 1 : (depth.get(n.id) || 0);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(n.id);
  });
  const pos = new Map();
  const XS = 120, XGAP = 175, YGAP = 74;
  groups.forEach((ids, d) => { ids.forEach((id, i) => pos.set(id, { x: XS + d * XGAP, y: 140 + i * YGAP })); });
  return pos;
}

function simulateCircuit(def, engine, inputValues) {
  const circuit = def.circuit || { nodes: [], edges: [] };
  const { nodes, edges } = circuit;
  const byId = new Map(); nodes.forEach((n) => byId.set(n.id, n));
  const inputs = nodes.filter((n) => n.kind === 'input').sort((a, b) => a.inputIndex - b.inputIndex);
  const outputs = nodes.filter((n) => n.kind === 'output').sort((a, b) => a.outputIndex - b.outputIndex);
  const deps = new Map();
  edges.forEach((e) => { if (!deps.has(e.to)) deps.set(e.to, []); deps.get(e.to).push({ from: e.from, port: e.port || 0, srcPort: e.srcPort || 0 }); });
  const value = new Map(); inputs.forEach((inp, i) => value.set(inp.id, inputValues[i] | 0));
  const visiting = new Set(); const multi = new Map();
  // Read the value produced by a source node on a given source port.
  const readFrom = (srcId, srcPort) => {
    const src = byId.get(srcId);
    if (src && src.kind === 'custom') {
      const bits = multi.has(srcId) ? multi.get(srcId) : evalNode(srcId);
      return (Array.isArray(bits) ? bits : [bits])[srcPort | 0] | 0;
    }
    return evalNode(srcId) | 0;
  };
  const evalNode = (id) => {
    if (value.has(id)) return value.get(id);
    if (multi.has(id)) return (multi.get(id)[0] | 0);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const n = byId.get(id);
    let r = 0;
    if (!n) { visiting.delete(id); return 0; }
    if (n.kind === 'input') r = value.get(id) | 0;
    else if (n.kind === 'const') r = n.value | 0;
    else if (n.kind === 'nand') {
      const ins = (deps.get(id) || []).slice().sort((a, b) => a.port - b.port);
      const a = ins[0] !== undefined ? readFrom(ins[0].from, ins[0].srcPort) : 0;
      const b = ins[1] !== undefined ? readFrom(ins[1].from, ins[1].srcPort) : 0;
      r = (a && b) ? 0 : 1;
    } else if (n.kind === 'output') {
      const ins = deps.get(id); r = ins && ins.length ? readFrom(ins[0].from, ins[0].srcPort) : 0;
    } else if (n.kind === 'custom') {
      const inner = engine.definitions.get(n.ref);
      if (inner) {
        const innerInputs = (deps.get(id) || []).slice().sort((a, b) => a.port - b.port).map((d) => readFrom(d.from, d.srcPort));
        const bits = simulateCircuit(inner, engine, innerInputs);
        multi.set(id, bits); visiting.delete(id); return bits[0] | 0;
      }
    }
    visiting.delete(id); value.set(id, r); return r;
  };
  return outputs.map((o) => evalNode(o.id) | 0);
}

function computeTicksForCircuit(circuit, definitions) {
  const nodes = circuit.nodes || [];
  const edges = circuit.edges || [];
  const byId = new Map(nodes.map(n=>[n.id,n]));
  const deps = new Map();
  edges.forEach(e => { if(!deps.has(e.to)) deps.set(e.to, []); deps.get(e.to).push(e.from); });
  const memo = new Map();
  const visiting = new Set();
  const depth = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const n = byId.get(id);
    let d = 0;
    if (!n) d = 0;
    else if (n.kind === 'input') d = 0;
    else if (n.kind === 'const') d = 0;
    else if (n.kind === 'nand') {
      const ds = (deps.get(id)||[]).map(s=>depth(s));
      d = 1 + (ds.length? Math.max(...ds):0);
    } else if (n.kind === 'custom') {
      const inner = definitions ? definitions.get(n.ref) : null;
      const innerTicks = inner ? (inner.ticks !== undefined ? inner.ticks : computeTicksForCircuit(inner.circuit, definitions)) : 0;
      const ds = (deps.get(id)||[]).map(s=>depth(s));
      const maxIn = ds.length? Math.max(...ds):0;
      d = maxIn + innerTicks;
    } else if (n.kind === 'output') {
      const src = (deps.get(id)||[])[0];
      d = src ? depth(src) : 0;
    }
    visiting.delete(id);
    memo.set(id,d);
    return d;
  };
  let max = 0;
  nodes.filter(n=>n.kind==='output').forEach(o=>{ max = Math.max(max, depth(o.id)); });
  return max;
}