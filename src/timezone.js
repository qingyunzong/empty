'use strict';

// 显式时区转换表：entries 为 [{ startUtcMs, offsetMinutes }]，按 startUtcMs 升序。
// 每个条目表示自 startUtcMs（含）起生效的 UTC 偏移。
class TimezoneTable {
  constructor(name, entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`timezone ${name}: entries must be a non-empty array`);
    }
    this.name = name;
    this.entries = entries.map((e) => ({
      startUtcMs: e.startUtcMs,
      offsetMinutes: e.offsetMinutes,
    }));
    for (let i = 1; i < this.entries.length; i++) {
      if (this.entries[i].startUtcMs <= this.entries[i - 1].startUtcMs) {
        throw new Error(`timezone ${name}: entries must be strictly increasing in startUtcMs`);
      }
    }
    for (const e of this.entries) {
      if (!Number.isFinite(e.startUtcMs) || !Number.isFinite(e.offsetMinutes)) {
        throw new Error(`timezone ${name}: invalid entry`);
      }
    }
    // 预计算每条目生效的本地时间起点，用于 local -> utc 转换。
    this.localStarts = this.entries.map(
      (e) => e.startUtcMs + e.offsetMinutes * 60000
    );
  }

  offsetAtUtc(utcMs) {
    let idx = 0;
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i].startUtcMs <= utcMs) idx = i;
      else break;
    }
    return this.entries[idx].offsetMinutes;
  }

  // 本地墙钟毫秒 -> UTC 毫秒。
  // 选取“本地生效起点 <= localMs 的最大条目”。对回拨造成的歧义本地时间，
  // 确定性地取较后条目（第二次出现）；对跳进造成的不存在本地时间，
  // 同样确定性地落入较后条目。
  utcFromLocal(localMs) {
    let idx = 0;
    for (let i = 0; i < this.localStarts.length; i++) {
      if (this.localStarts[i] <= localMs) idx = i;
      else break;
    }
    const e = this.entries[idx];
    return localMs - e.offsetMinutes * 60000;
  }

  minOffsetMinutes() {
    return Math.min(...this.entries.map((e) => e.offsetMinutes));
  }

  maxOffsetMinutes() {
    return Math.max(...this.entries.map((e) => e.offsetMinutes));
  }
}

function buildTimezoneTables(spec) {
  const tables = {};
  for (const [name, entries] of Object.entries(spec || {})) {
    tables[name] = new TimezoneTable(name, entries);
  }
  return tables;
}

module.exports = { TimezoneTable, buildTimezoneTables };
