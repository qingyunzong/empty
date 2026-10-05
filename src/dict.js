import fs from 'node:fs';
import path from 'node:path';
import { readJson, atomicWriteJson } from './util.js';

// Shared, versioned token dictionary. Old versions are immutable so frozen
// segments written against an older version stay decodable forever.
export class Dictionary {
  constructor(archiveDir) {
    this.dir = path.join(archiveDir, 'dict');
  }

  file(version) {
    return path.join(this.dir, `dict-${version}.json`);
  }

  load(version) {
    const data = readJson(this.file(version), null);
    if (!data) throw new Error(`dictionary version ${version} missing`);
    return data;
  }

  latestVersion() {
    let latest = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        const m = /^dict-(\d+)\.json$/.exec(name);
        if (m) latest = Math.max(latest, Number(m[1]));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return latest;
  }

  // Encode tokens to ids against the latest version, creating a new version
  // (never mutating old ones) when unknown tokens appear.
  encode(tokens) {
    let version = this.latestVersion();
    let table;
    if (version === 0) {
      table = { version: 1, tokens: [] };
    } else {
      table = this.load(version);
    }
    const ids = new Map(table.tokens.map((t, i) => [t, i]));
    const added = [];
    for (const tok of tokens) {
      if (!ids.has(tok)) {
        ids.set(tok, table.tokens.length + added.length);
        added.push(tok);
      }
    }
    if (added.length > 0 || version === 0) {
      version = table.version + (version === 0 ? 0 : 1);
      if (version === 0) version = 1;
      const next = { version, tokens: [...table.tokens, ...added] };
      fs.mkdirSync(this.dir, { recursive: true });
      atomicWriteJson(this.file(version), next);
    }
    return { version, ids };
  }

  decode(version, idList) {
    const table = this.load(version);
    return idList.map((id) => {
      const tok = table.tokens[id];
      if (tok === undefined) throw new Error(`dict v${version} has no id ${id}`);
      return tok;
    });
  }
}
