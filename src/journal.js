import fs from 'node:fs';

export class Journal {
  constructor(path) {
    this.path = path;
    this.keys = new Set();
    if (fs.existsSync(path)) {
      const text = fs.readFileSync(path, 'utf8');
      let valid = 0;
      let idx = 0;
      for (;;) {
        const nl = text.indexOf('\n', idx);
        if (nl === -1) break;
        try {
          const obj = JSON.parse(text.slice(idx, nl));
          if (obj && typeof obj.key === 'string') {
            this.keys.add(obj.key);
            valid = nl + 1;
          } else {
            break;
          }
        } catch {
          break;
        }
        idx = nl + 1;
      }
      if (valid !== text.length) fs.truncateSync(path, valid);
    }
    this.fd = fs.openSync(path, 'a');
  }

  has(key) {
    return this.keys.has(key);
  }

  append(obj) {
    if (this.keys.has(obj.key)) return false;
    fs.writeSync(this.fd, JSON.stringify(obj) + '\n');
    fs.fsyncSync(this.fd);
    this.keys.add(obj.key);
    return true;
  }

  close() {
    fs.closeSync(this.fd);
  }
}
