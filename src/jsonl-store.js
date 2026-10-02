import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class JsonlStore {
  constructor(path) {
    this.path = path;
  }

  append(event) {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8');
  }

  load() {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }
}
