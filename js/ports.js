// Port + node geometry shared between renderer and interactor so click/drag
// targets match what's drawn exactly.
//
// Nodes are rendered as rounded rectangles whose size depends on:
//   - the number of input ports (sets height)
//   - the number of output ports (sets height)
//   - the longest label/name (sets width)
// Arity is a per-node property (inputCount/outputCount) so custom nodes with
// arbitrary fan-in/fan-out work just like primitives.
//
// Port positions sit exactly ON the vertical edge of the body: input ports on
// the left edge at x = node.x - hw, output ports on the right edge at
// x = node.x + hw, where hw is the node's half-width (computed by nodeSize).
// Because width varies with the label, callers must pass the half-width.

export const PORT_R = 5;
export const NODE_R = 18;         // min half-extent used when half-width unknown
const PORT_GAP = 20;              // vertical spacing between adjacent ports
const PORT_MARGIN = 12;           // vertical padding above/below outermost ports
const PAD_X = 12;                 // horizontal padding inside the rectangle
const PAD_Y = 10;                 // vertical padding around the label band
const MIN_W = 56;                 // minimum body width
const MIN_H = 36;                 // minimum body height
const H_CHAR = 6.6;               // approx width per char at 12px font (sans-serif)

export function inputPortCount(node) {
  return node.inputCount | 0;
}
export function outputPortCount(node) {
  return node.outputCount | 0;
}

// Compute rounded-rect size for a node given the longest text we want to fit.
// Caller passes the longest display string; we measure it with H_CHAR.
export function nodeSize(node, longestText) {
  const nIn = inputPortCount(node);
  const nOut = outputPortCount(node);
  const portRows = Math.max(nIn, nOut, 1);
  const portSpan = (portRows - 1) * PORT_GAP;
  const h = Math.max(MIN_H, portSpan + PORT_MARGIN * 2);
  const w = Math.max(MIN_W, Math.ceil((longestText || '').length * H_CHAR) + PAD_X * 2);
  return { w, h };
}

// Vertical distribution of n ports around the node center.
function distribute(node, n, i) {
  if (n <= 1) return node.y;
  const span = (n - 1) * PORT_GAP;
  return node.y - span / 2 + i * PORT_GAP;
}

// Half-extents of the node body at (node.x, node.y) given the longest text.
export function nodeHalfExtents(node, longestText) {
  const { w, h } = nodeSize(node, longestText);
  return { hw: w / 2, hh: h / 2 };
}

// Position of an input port (left edge). Pass hw = half-width so the port
// sits exactly on the body edge even when the label widens the node.
export function inputPortPos(node, port, hw) {
  const n = Math.max(1, inputPortCount(node));
  const hwx = hw === undefined ? NODE_R : hw;
  return { x: node.x - hwx, y: distribute(node, n, port) };
}

// Position of an output port (right edge).
export function outputPortPos(node, port = 0, hw) {
  const n = Math.max(1, outputPortCount(node));
  const hwx = hw === undefined ? NODE_R : hw;
  return { x: node.x + hwx, y: distribute(node, n, port) };
}