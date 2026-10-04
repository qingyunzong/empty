import { open, readFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function writeTmp(file, data) {
  const handle = await open(file, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Durable write: tmp file + fsync + atomic rename. hooks.beforeRename is a
// fault-injection point used by crash-recovery tests.
export async function atomicWriteJson(file, obj, hooks = {}) {
  const tmp = `${file}.tmp`;
  await writeTmp(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  if (hooks.beforeRename) await hooks.beforeRename();
  await rename(tmp, file);
}

export async function appendJsonLine(file, obj) {
  const handle = await open(file, 'a');
  try {
    await handle.writeFile(`${JSON.stringify(obj)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJsonLines(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) out.push(JSON.parse(trimmed));
  }
  return out;
}

// Crash recovery step: a leftover *.tmp means the rename never happened, so
// the temporary file is discarded and the last committed file stands.
export async function discardTmpFiles(dir) {
  const discarded = [];
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return discarded;
    throw err;
  }
  for (const name of names) {
    if (name.endsWith('.tmp')) {
      await unlink(path.join(dir, name));
      discarded.push(name);
    }
  }
  return discarded;
}
