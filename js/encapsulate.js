// Encapsulation: take a set of nodes from the current canvas and turn them
// into a custom-node definition. The sub-circuit becomes a reusable primitive.
//
// A custom node is fully closed: it exposes NO implicit ports. Its external
// input/output ports are determined strictly by the INPUT and OUTPUT nodes the
// user placed inside the selection:
//   - every internal INPUT  node becomes one input  port (in inputIndex order)
//   - every internal OUTPUT node becomes one output port (in outputIndex order)
// Cross-boundary wires to/from non-selected nodes are dropped — the user must
// route the outside world through explicit INPUT/OUTPUT nodes.
//
// Port names inherit the INPUT/OUTPUT node's own port name (inputNames[0] /
// outputNames[0]) or node name.

import { NodeKind } from './model.js';

export function buildDefinitionFromCircuit(engine, selectedIds) {
  const selected = new Set(selectedIds);
  const nodes = engine.getNodes().filter((n) => selected.has(n.id));
  if (nodes.length === 0) return { nodes: [], edges: [], ports: { inputs: [], outputs: [] } };

  const circuitNodes = [];
  const edges = [];
  const inputNames = [];   // parallel to input ports
  const outputNames = [];  // parallel to output ports

  // 1. Copy selected nodes. Internal INPUT/OUTPUT nodes become the definition's
  //    ports; their order is the port order.
  for (const n of nodes) {
    const copy = {
      id: n.id,
      kind: kindLower(n.kind),
      inputIndex: 0,
      outputIndex: 0,
      ref: n.ref || null,
      name: n.name || '',
      value: n.value | 0,
      x: n.x,
      y: n.y,
    };
    if (n.kind === NodeKind.INPUT) {
      copy.inputIndex = inputNames.length;
      inputNames.push(n.outputNames && n.outputNames[0] ? n.outputNames[0] : (n.name || ''));
    }
    if (n.kind === NodeKind.OUTPUT) {
      copy.outputIndex = outputNames.length;
      outputNames.push(n.inputNames && n.inputNames[0] ? n.inputNames[0] : (n.name || ''));
    }
    circuitNodes.push(copy);
  }

  // 2. Internal wires among selected nodes pass through as-is.
  for (const n of nodes) {
    if (!n.inputs) continue;
    n.inputs.forEach((srcId, port) => {
      if (!srcId) return;
      if (selected.has(srcId)) {
        edges.push({ from: srcId, to: n.id, port, srcPort: (n.sourcePorts && n.sourcePorts[port]) | 0 });
      }
    });
  }

  return {
    nodes: circuitNodes,
    edges,
    ports: { inputs: inputNames, outputs: outputNames },
  };
}

function kindLower(k) {
  if (k === NodeKind.CUSTOM) return 'custom';
  return k;
}
