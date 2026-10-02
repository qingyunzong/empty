'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');

const {
  ReportError,
  roleClosure,
  sourceClosure,
  buildReport,
  verifyReport,
} = require('../lib');


function baseSpec() {
  return {
    levels: ['public', 'internal', 'confidential', 'secret'],
    roles: {
      viewer: { clearance: 'public', inherits: [] },
      analyst: { clearance: 'internal', inherits: ['viewer'] },
      controller: { clearance: 'confidential', inherits: ['analyst'] },
    },
    units: {
      u_pub: { level: 'public', version: 1, fields: { amount: 100, n: 1 } },
      u_int: { level: 'internal', version: 1, fields: { amount: 200, n: 2 } },
      u_conf: { level: 'confidential', version: 2, fields: { amount: 400, salary: 400 } },
      agg: { aggregate: true, sources: ['u_pub', 'u_int'] },
    },
    grants: [],
    masks: [],
    request: { unit: 'agg', role: 'analyst' },
  };
}

// 验收1: 继承可读 -> 汇总签发与验证通过
test('1. inherited clearance makes aggregate visible; build+verify pass', () => {
  const spec = baseSpec();
    // analyst 经 inherits 继承 viewer 的 public,加上自身 internal,可读 u_pub 与 u_int
  const report = buildReport(spec, spec.request);
  assert.equal(report.unit, 'agg');
  assert.deepEqual(report.proof.sourceClosure, ['u_int', 'u_pub']);
  assert.deepEqual(report.fields, { amount: 300, n: 3 });
  const viaAllow = report.proof.rulePath.filter((e) => e.decision === 'allow');
  assert.equal(viaAllow.length, 2);
  // 规则路径含继承链:analyst -> viewer
  assert.deepEqual(viaAllow[0].rolePath, ['analyst', 'viewer']);
  assert.match(report.proof.canonicalHash, /^sha256:[0-9a-f]{64}$/);
  const res = verifyReport(report);
  assert.equal(res.ok, true);
});

// 验收1b: 显式 allow 授权同样沿 DAG 继承
test('1b. explicit allow grant is inherited through the role DAG', () => {
  const spec = baseSpec();
  delete spec.roles.analyst.clearance; // analyst 自身无 clearance
  spec.grants.push({ role: 'viewer', unit: 'u_int', effect: 'allow' });
  const report = buildReport(spec, spec.request);
  const entry = report.proof.rulePath.find((e) => e.unit === 'u_int');
  assert.equal(entry.decision, 'allow');
  assert.match(entry.via, /explicit-allow\(viewer\)/);
  assert.equal(verifyReport(report).ok, true);
});

// 验收2: 一个来源 deny -> 失败并给出最小越权集合
test('2. one denied source fails build with minimal over-authority set', () => {
  const spec = baseSpec();
  spec.units.agg.sources = ['u_pub', 'u_int', 'u_conf'];
  spec.roles.controller = { clearance: 'confidential', inherits: ['analyst'] };
  spec.request.role = 'controller';
  // controller 本可读全部,但对 u_conf 显式 deny(deny 优先)
  spec.grants.push({ role: 'analyst', unit: 'u_conf', effect: 'deny' });
  assert.throws(
    () => buildReport(spec, spec.request),
    (err) => {
      assert.equal(err.code, 'E_AUTH');
      assert.deepEqual(err.details.minimalSet, ['u_conf']);
      assert.equal(err.details.failures.length, 1);
      assert.match(err.details.failures[0].reason, /explicit-deny/);
      return true;
    }
  );
});

// 验收2b: deny 优先于 allow(冲突时 deny 胜)
test('2b. deny wins over allow on conflict', () => {
  const spec = baseSpec();
  spec.grants.push({ role: 'viewer', unit: 'u_int', effect: 'allow' });
  spec.grants.push({ role: 'analyst', unit: 'u_int', effect: 'deny' });
  assert.throws(
    () => buildReport(spec, spec.request),
    (err) => err.code === 'E_AUTH' && err.details.minimalSet.length === 1
  );
});

// 验收3: 脱敏版本不匹配 -> E_MASK
test('3. mask version mismatch raises E_MASK', () => {
  const spec = baseSpec();
  spec.units.agg.sources = ['u_pub', 'u_int', 'u_conf'];
  // analyst(internal) 读不了 confidential 的 u_conf,脱敏规则版本 1 != 单元版本 2
  spec.masks.push({ id: 'm1', unit: 'u_conf', field: 'salary', version: 1, roles: ['analyst'] });
  assert.throws(
    () => buildReport(spec, spec.request),
    (err) => {
      assert.equal(err.code, 'E_MASK');
      assert.deepEqual(err.details.minimalSet, ['u_conf']);
      assert.equal(err.details.failures[0].reason, 'mask-version-mismatch');
      assert.equal(err.details.failures[0].maskVersion, 1);
      assert.equal(err.details.failures[0].unitVersion, 2);
      return true;
    }
  );
});

// 验收3b: 版本匹配的脱敏规则覆盖不可读来源,脱敏字段不参与汇总
test('3b. matching mask covers unreadable source and redacts the masked field', () => {
  const spec = baseSpec();
  spec.units.agg.sources = ['u_pub', 'u_int', 'u_conf'];
  spec.masks.push({ id: 'm1', unit: 'u_conf', field: 'salary', version: 2, roles: ['analyst'] });
  const report = buildReport(spec, spec.request);
  const entry = report.proof.rulePath.find((e) => e.unit === 'u_conf');
  assert.equal(entry.decision, 'mask');
  assert.equal(entry.maskId, 'm1');
  // salary 被脱敏剔除,amount 仍计入
  assert.deepEqual(report.fields, { amount: 700, n: 3 });
  assert.equal(verifyReport(report).ok, true);
});

// 验收4: 撤销脱敏 -> 旧报表 verify 仍通过,新签发失败
test('4. revoking a mask does not retroactively fail issued reports but blocks new issuance', () => {
  const spec = baseSpec();
  spec.units.agg.sources = ['u_pub', 'u_int', 'u_conf'];
  spec.masks.push({ id: 'm1', unit: 'u_conf', field: 'salary', version: 2, roles: ['analyst'] });
  const issued = buildReport(spec, spec.request);

  // 撤销脱敏规则(模拟规则库变更)
  const revoked = baseSpec();
  revoked.units.agg.sources = ['u_pub', 'u_int', 'u_conf'];

  // 旧报表自包含快照,verify 不读当前规则 -> 仍通过
  assert.equal(verifyReport(issued).ok, true);
  // 新签发使用当前 spec,脱敏已撤销 -> E_AUTH
  assert.throws(
    () => buildReport(revoked, revoked.request),
    (err) => err.code === 'E_AUTH' && JSON.stringify(err.details.minimalSet) === '["u_conf"]'
  );
});

// 验收5: 小图枚举对照 —— 角色闭包与来源闭包对照朴素不动点枚举
test('5. closure computation matches brute-force enumeration on small graphs', () => {
  const rng = mulberry32(20261002);
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(rng() * 7); // 1..7 个节点
    const names = Array.from({ length: n }, (_, i) => 'r' + i);
    // 随机 DAG:仅允许小编号 <- 大编号边,保证无环
    const roles = {};
    for (let i = 0; i < n; i++) {
      const parents = names.slice(0, i).filter(() => rng() < 0.4);
      roles[names[i]] = { inherits: parents };
    }
    for (const start of names) {
      const got = new Set(roleClosure(roles, start));
      const want = bruteClosure(roles, start);
      assert.deepEqual([...got].sort(), [...want].sort());
    }
  }
  // 来源闭包对照:随机嵌套汇总图
  for (let trial = 0; trial < 200; trial++) {
    const n = 2 + Math.floor(rng() * 6);
    const ids = Array.from({ length: n }, (_, i) => 'u' + i);
    const units = {};
    for (let i = 0; i < n; i++) {
      if (i > 0 && rng() < 0.5) {
        const srcs = ids.slice(0, i).filter(() => rng() < 0.5);
        units[ids[i]] = srcs.length ? { aggregate: true, sources: srcs } : { level: 'public', version: 1, fields: {} };
      } else {
        units[ids[i]] = { level: 'public', version: 1, fields: {} };
      }
    }
    const spec = { units };
    for (const id of ids) {
      if (!units[id].aggregate) continue;
      const got = sourceClosure(spec, id);
      const want = [...bruteLeaves(units, id)].sort();
      assert.deepEqual(got, want);
    }
  }
});

function bruteClosure(roles, start) {
  const seen = new Set([start]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of [...seen]) {
      for (const p of roles[r].inherits || []) {
        if (!seen.has(p)) { seen.add(p); changed = true; }
      }
    }
  }
  return seen;
}

function bruteLeaves(units, id) {
  const out = new Set();
  const walk = (x) => {
    const u = units[x];
    if (u.aggregate) u.sources.forEach(walk);
    else out.add(x);
  };
  walk(id);
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 篡改检测:哈希不匹配 -> E_HASH
test('tampered report fails verify with E_HASH', () => {
  const spec = baseSpec();
  const report = buildReport(spec, spec.request);
  report.fields.amount = 999999;
  assert.throws(() => verifyReport(report), (err) => err.code === 'E_HASH');
});

// 重算检测:快照内来源数据被改但哈希重签不可能,故改 fields 同时改 hash 不可行;
// 这里直接构造 hash 正确但授权失败的报表 -> verify 给最小集合
test('verify re-evaluates authorization from embedded snapshot', () => {
  const spec = baseSpec();
  const report = buildReport(spec, spec.request);
  // 在快照中把 u_int 改为 deny,并重算哈希(模拟签发后快照被构造性攻击)
  report.proof.grantSnapshot.push({ role: 'viewer', unit: 'u_int', effect: 'deny' });
  const { canonicalHash } = require('../lib');
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.proof.canonicalHash;
  report.proof.canonicalHash = canonicalHash(copy);
  assert.throws(
    () => verifyReport(report),
    (err) => err.code === 'E_AUTH' && JSON.stringify(err.details.minimalSet) === '["u_int"]'
  );
});

// 环检测:角色继承环 -> E_CYCLE
test('role inheritance cycle raises E_CYCLE', () => {
  const spec = baseSpec();
  spec.roles.viewer.inherits = ['analyst'];
  assert.throws(() => buildReport(spec, spec.request), (err) => err.code === 'E_CYCLE');
});

// CLI 端到端(进程内调用 run,沙箱禁止 spawn 子进程):build/verify 成功路径
function makeIo() {
  const out = { stdout: '', stderr: '' };
  return {
    io: { stdout: (s) => { out.stdout += s; }, stderr: (s) => { out.stderr += s; } },
    out,
  };
}

test('cli: build then verify succeeds (exit 0)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regreport-'));
  const specPath = path.join(dir, 'spec.json');
  const reportPath = path.join(dir, 'report.json');
  fs.writeFileSync(specPath, JSON.stringify(baseSpec()));
  let h = makeIo();
  assert.equal(run(['build', specPath, reportPath], h.io), 0);
  assert.match(h.out.stdout, /^built /);
  assert.equal(h.out.stderr, '');
  h = makeIo();
  assert.equal(run(['verify', reportPath], h.io), 0);
  assert.match(h.out.stdout, /^OK /);
  assert.equal(h.out.stderr, '');
});

// CLI 端到端:越权 -> stderr 含 E_AUTH 与最小集合,退出码 1
test('cli: unauthorized build exits 1 with E_AUTH on stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regreport-'));
  const spec = baseSpec();
  spec.units.agg.sources = ['u_pub', 'u_int', 'u_conf'];
  const specPath = path.join(dir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const h = makeIo();
  assert.equal(run(['build', specPath, path.join(dir, 'r.json')], h.io), 1);
  assert.match(h.out.stderr, /^E_AUTH:/);
  assert.match(h.out.stderr, /u_conf/);
  assert.equal(h.out.stdout, '');
});

// CLI 端到端:非法 JSON -> stderr + 退出码 1
test('cli: invalid JSON input exits 1 with E_PARSE on stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regreport-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  const h = makeIo();
  assert.equal(run(['verify', bad], h.io), 1);
  assert.match(h.out.stderr, /^E_PARSE:/);
});

// CLI 端到端:缺参数 -> usage 到 stderr,退出码 1
test('cli: missing args prints usage to stderr and exits 1', () => {
  const h = makeIo();
  assert.equal(run([], h.io), 1);
  assert.match(h.out.stderr, /^usage:/);
});
