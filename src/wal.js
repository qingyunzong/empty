import fs from 'node:fs';

export function appendRecords(path, records) {
  const fd = fs.openSync(path, 'a');
  try {
    for (const record of records) {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function recoverRecords(path) {
  if (!fs.existsSync(path)) {
    return { records: [], truncated: false, truncatedBytes: 0 };
  }
  const buf = fs.readFileSync(path);
  const records = [];
  let offset = 0;
  let torn = false;
  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl === -1) {
      torn = true;
      break;
    }
    const line = buf.subarray(offset, nl).toString('utf8');
    try {
      records.push(JSON.parse(line));
    } catch {
      torn = true;
      break;
    }
    offset = nl + 1;
  }
  let truncatedBytes = 0;
  if (torn) {
    truncatedBytes = buf.length - offset;
    const fd = fs.openSync(path, 'r+');
    try {
      fs.ftruncateSync(fd, offset);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  return { records, truncated: torn, truncatedBytes };
}
