# Nandmorphic

A NAND-only logic circuit playground in the browser. Build circuits from NAND
gates and I/O nodes, simulate them live, and abstract any finished circuit
into a reusable **custom node**.

Pure HTML / CSS / JavaScript + Canvas. No frameworks, no build step.

## Run

```sh
node server.mjs
# open http://localhost:8791
```

Any static file server works — the app is fully client-side. `server.mjs` is
just a convenience dev server (it sends `Cache-Control: no-store` so you
always get fresh files while developing).

## Concepts

- **Nodes** are `input`, `output`, `nand`, or `custom`. Wires live on each
  node's `inputs` array together with `sourcePorts` (which output port of the
  source node each wire reads).
- **Clock-based evaluation** — combinational logic evaluates immediately in
  topological order. Feedback loops are detected (Tarjan SCC) and treated as
  sequential: they update on the clock's rising edge only. Press `Space` or
  the Clock button to advance the clock; the `clk` counter increments on the
  falling edge.
- **Custom nodes** (`encapsulate.js`) reify a selected sub-circuit as a
  reusable definition. Wires crossing the selection boundary become the new
  node's input/output ports. Identical circuits are deduplicated by truth-table
  signature (`optimizer.js`), so building the same gate twice reuses one
  shared definition.
- **Library** (left panel) — click a custom node to drop an instance onto the
  canvas. `▲`/`▼` reorder definitions, `✕` deletes one. A definition that
  would create a cycle at the current level is marked `blocked`.
- **Levels / tabs** — opening a custom node pushes an editing level (tab).
  The tab's close button shows `✕` when clean and an orange `●` when dirty.
  Closing a dirty tab offers *Save and Close* / *Close without Saving* /
  *Return to Edit*. `Ctrl+S` inside a custom-node tab commits the level
  (rebuilds the definition and updates the parent circuit).
- **Inspector** — double-click any node to rename it and reorder its ports
  with `▲`/`▼` (wires follow the moved ports). Custom nodes also offer
  *Open Internals* to drill into their circuit.

## Controls

| Action | Input |
|---|---|
| Add input / output / NAND | toolbar, or `I` / `O` / `N` (dev mode) |
| Toggle input value | click the input node (run mode) |
| Move node | drag it |
| Wire nodes | drag from a node's output port to an input port |
| Disconnect | drag an existing wire onto empty space |
| Select | click (shift-add) or marquee-drag empty space |
| Copy / paste | `Ctrl+C` / `Ctrl+V` |
| Delete selection | `Delete` / `Backspace` |
| Encapsulate selection | toolbar, or `E` (dev mode) |
| Node settings | double-click it |
| Open custom node | toolbar Open Node, or inspector → Open Internals |
| Up one level / clear selection | `Esc` |
| Advance clock | `Space`, `C`, or Clock button |
| Run / dev mode | Run: Play button (run = auto-clock + input toggle, editing locked) |
| Commit custom-node tab | `Ctrl+S` |
| Export workspace JSON | toolbar, `Ctrl+Shift+S`, or `Ctrl+E` |
| Import workspace JSON | toolbar Import |

## Project layout

```
index.html            markup + toolbar + modal shell
css/style.css         styling
server.mjs            optional dev server (no-store cache headers)
js/
  main.js             composition root: engine/renderer/interactor/UI/tabs
  model.js            NodeKind, id helpers, value evaluation, graph iteration
  engine.js           node graph, wiring, definition registry, clock evaluation
  renderer.js         canvas drawing (nodes, wires, live values)
  interact.js         pointer/keyboard: move / wire / delete / marquee / toggle
  encapsulate.js      wrap a sub-circuit into a self-contained definition
  optimizer.js        truth-table signature + canonical form for dedup
  ports.js            port geometry (arbitrary fan-in / fan-out)
  storage.js          IndexedDB helper (currently not wired into the UI)
```

## Versioning / cache rule (for contributors)

Every JS import carries a `?v=B<n>` suffix (plus the entry script tag in
`index.html`), and `seed()` logs `[nandmorphic] BUILD B<n>` to the console.
Static hosts may cache ES modules aggressively, so **any change to `js/`
must bump the suffix on all imports and the BUILD tag together**. The dev
server strips the query string when resolving files, so the suffixes are
harmless locally.

## Smoke checklist (before publishing)

1. Page loads with zero console errors; console shows the current `BUILD` tag.
2. Seed circuit reads `NAND(A=0,B=1)=1` — output node bright, its wire green.
3. Switch to Run mode: `clk` counter advances on its own.
4. Click an input: its wire changes state and the output node flips.
5. `Space` and the Clock button both advance `clk`.
6. Encapsulate the seed NAND into a custom node, insert an instance from the
   Library, and confirm its output follows input toggles (custom live eval).
7. Double-click the instance: reorder input/output ports with `▲`/`▼`, press
   OK, and confirm wires followed the moved ports and values still evaluate.
8. Reorder definitions in the Library with `▲`/`▼`.
9. Drill into the custom node, edit it, and confirm the tab shows `●`; close
   it and walk through Save and Close / Close without Saving / Return to Edit.

## License

Copyright (c) 2026 Nandmorphic contributors.\
Licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
(`SPDX-License-Identifier: CC-BY-NC-SA-4.0`, see `LICENSE`). In short: you may
use, modify, and share this project **for non-commercial purposes only**, you
must give credit, and any derivative must be shared under the same terms.
