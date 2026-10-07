# terminal-buffer

A terminal screen buffer library in TypeScript.

## Semantics

- **Text / CR / cursor movement** — `write(text)` handles `\n` (line feed,
  scrolls at the region's bottom edge) and `\r` (carriage return); cursor
  moves via `cursorUp/Down/Forward/Back`, `cursorTo`, all clamped.
- **Wide characters** — width-2 chars (per the given width table in
  `src/width-table.ts`, the only width source) occupy two cells
  (`wide-left` + `wide-right`). Overwriting either half clears the whole
  old character. A wide char that does not fit in the last column wraps
  whole to the next line.
- **Combining marks** — width-0 marks attach to the previous base char
  (including wide chars). At line start they are stored standalone in a
  `zero-width` cell; a later base char absorbs them.
- **Insert / delete** — `insertChars(n)` / `deleteChars(n)` shift cells in
  the current line; a wide char split by the operation is cleared entirely.
- **Scrolling** — `scrollUp(n)` / `scrollDown(n)` operate inside the scroll
  region set with `setScrollRegion(top, bottom)` (0-based, inclusive).
  Wide chars never straddle a scroll boundary as dangling halves.
- **Save / restore** — `saveScreen()` takes a deep snapshot (grid, cursor,
  region); later combining marks never mutate the saved snapshot, and
  `restoreScreen()` can be applied repeatedly.
- **Inspection** — `cellAt(x, y)`, `renderLine(y)` and `render()` expose
  the cell state after every operation.

## Test

```sh
npm test   # compiles with tsc and runs node --test
```
