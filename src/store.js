// JSON 文件持久化。提交协议（故障点明确）：
//   1. beforeTempWrite  —— 写临时文件之前（崩溃点：状态文件尚未被触碰）
//   2. 写 <path>.tmp 并 fsync
//   3. afterTempWrite   —— 临时文件已落盘，但尚未生效
//   4. beforeRename     —— rename 之前（崩溃点：旧文件仍完整，临时文件被清理）
//   5. rename(tmp, path)—— 原子生效点：rename 完成才算提交成功
//   6. afterRename
// 任何一步失败：临时文件被清理，旧状态文件保持可打开、内容不变，无半笔事务。
// load 只读取正式路径，忽略残留的 .tmp 文件。
import fs from 'node:fs';

export class JsonStore {
  constructor(path, hooks = {}) {
    this.path = path;
    this.hooks = hooks;
  }

  get tmpPath() {
    return `${this.path}.tmp`;
  }

  exists() {
    return fs.existsSync(this.path);
  }

  load() {
    return JSON.parse(fs.readFileSync(this.path, 'utf8'));
  }

  commit(state) {
    const tmp = this.tmpPath;
    try {
      this.hooks.beforeTempWrite?.(this.path);
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      const fd = fs.openSync(tmp, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.hooks.afterTempWrite?.(this.path);
      this.hooks.beforeRename?.(this.path);
      fs.renameSync(tmp, this.path);
      this.hooks.afterRename?.(this.path);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* 临时文件可能尚未创建 */ }
      throw e;
    }
  }
}
