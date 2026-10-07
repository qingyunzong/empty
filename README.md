# doc-index

Incremental Markdown document index: extracts **headings**, **explicit
anchors** and **internal references**, with correct handling of fenced code
blocks and forward references.

## Features

- **Headings** — ATX headings (`#` … `######`). Ids are generated from the
  visible text: ASCII lowercase, non-alphanumerics dropped, whitespace runs
  collapsed to a single `-`. Duplicates get numeric suffixes
  (`intro`, `intro-1`, `intro-2`, …).
- **Anchors** — heading ids plus explicit `<a name="…">` / `<a id="…">` tags.
- **References** — `[text](#target)` links. Resolution happens after the
  whole document is indexed, so **forward references** (to anchors defined
  later) resolve correctly. Unresolvable references are reported with
  `resolved: false`.
- **Code fences** — content inside ```` ``` ```` / `~~~` fenced blocks is
  ignored (CommonMark-style: closing fence must use the same marker and be
  at least as long).
- **Incremental edits** — `edit(startLine, deleteCount, inserted)` re-lexes
  only the edited lines plus whatever is needed to re-synchronize the fence
  state, so a fence that spans the edited region is handled correctly. The
  resulting index is always identical to a full re-scan (verified by a
  randomized fuzz test).

## Usage

```ts
import { DocumentIndex } from "doc-index";

const doc = new DocumentIndex("# Intro\n\nSee [later](#appendix).\n\n## Appendix\n");

doc.headings;
// [ { level: 1, text: "Intro", id: "intro", line: 0 },
//   { level: 2, text: "Appendix", id: "appendix", line: 4 } ]

doc.references[0]; // { target: "appendix", line: 2, resolved: true }

// Insert an opening fence above the headings — they disappear from the index:
doc.edit(0, 0, ["```"]);
doc.headings; // []

// Replace lines 1..2 with a closing fence and a new heading:
doc.edit(1, 2, ["```", "# Back"]);
doc.headings; // [ { level: 1, text: "Back", id: "back", line: 2 }, … ]
```

## API

- `new DocumentIndex(text)` / `scan(text)` — full scan.
- `doc.edit(startLine, deleteCount, insertedLines)` — incremental update
  (0-based lines; `startLine === lineCount` appends).
- `doc.headings`, `doc.anchors`, `doc.references` — index snapshots.
- `doc.getAnchor(name)`, `doc.isResolved(target)` — lookups.
- `doc.toText()`, `doc.lineCount` — document access.
- `slugify(text)`, `Slugger` — id generation utilities.

## Develop

```sh
npm test   # tsc && node --test dist/test/*.test.js
```

Requires Node.js ≥ 18 and a `tsc` on PATH (or `npm i -D typescript`).
