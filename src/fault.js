// Fault injection: simulate power loss by truncating a file at an exact byte
// offset. Anything past the offset is what the crash "lost".

import fs from 'node:fs';

export function truncateAt(filePath, byteOffset) {
  fs.truncateSync(filePath, byteOffset);
}
