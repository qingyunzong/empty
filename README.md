# command-session-parser

Streaming parser for command (terminal) sessions, written in TypeScript on
top of Node.js built-in modules only. It keeps the three byte flows of a
session apart, interprets control sequences through a public finite table,
flags truncated commands, and guarantees that arbitrary chunking of the
input produces the same interpretation as parsing the whole buffer at once.

## Model

- **Sent bytes** — `send(data)` records everything sent to the terminal.
  Each record (`SentCommand`) keeps its text and its byte offsets in the
  sent stream. A command without a trailing CR/LF is recorded with
  `complete: false` (truncated command).
- **Echo** — received text that matches pending sent bytes is classified as
  `echo`. Echo is visible on screen but is never reported as program output.
- **Output** — all other received text is program output (`output`).
- **Control sequences** — received bytes are interpreted exclusively through
  the exported finite table `CONTROL_SEQUENCES` (BEL/BS/LF/CR, SGR, cursor
  movement, cursor position, erase in line/display). Known sequences apply
  their declared effect to the visible-text model. Anything else that looks
  like an escape sequence is consumed deterministically as an `UNKNOWN`
  control segment with no effect on visible state.
- **Truncation** — if the received stream ends in the middle of an escape
  sequence, the tail becomes a `control` segment with `complete: false`.

Every segment carries `start`/`end` byte offsets into the original received
stream, so `received.slice(start, end)` always yields the segment's bytes.

## Chunk invariance

`write(chunk)` accepts arbitrary chunks. Feeding the same bytes as one
buffer, split at every possible position, split randomly, or byte-at-a-time
yields identical segments (kind, text, original offsets, completeness),
identical `visibleText()`, `outputText()`, `echoText()` and `commands`.
This is enforced by the test suite.

## API

```ts
import { SessionParser, CONTROL_SEQUENCES } from "./src/index.js";

const parser = new SessionParser();
parser.send("ls\r");                 // record sent bytes
parser.write(chunk1);                // feed received bytes, any chunking
parser.write(chunk2);
parser.end();                        // flush; marks truncated tails

parser.segments;                     // echo | output | control, with offsets
parser.commands;                     // sent commands, complete flags
parser.visibleText();                // screen text after control effects
parser.outputText();                 // program result only (no echo)
parser.echoText();                   // terminal echo only
parser.sentText();                   // all sent bytes
```

## Requirements and tests

- Node.js >= 18 and a `tsc` on `PATH` (no npm dependencies; the runtime uses
  only Node.js built-ins).
- `npm test` compiles with `tsc` and runs the `node:test` suite.
- `npm run build` only compiles.

See `TEST-RESULTS.md` for the recorded output of the latest run.
