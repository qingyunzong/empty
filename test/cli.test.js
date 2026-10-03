import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// 注：本沙箱中嵌套 node 的 stdout 管道会被吞掉，故用临时文件重定向 stdin/stdout。
function runCli(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsnet-cli-'));
  const inFile = path.join(dir, 'in.jsonl');
  const outFile = path.join(dir, 'out.jsonl');
  fs.writeFileSync(inFile, input);
  const res = spawnSync('sh', ['-c', `"${process.execPath}" "${CLI}" < "${inFile}" > "${outFile}"`], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const stdout = fs.readFileSync(outFile, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return stdout.trim().split('\n').map((l) => JSON.parse(l));
}

test('CLI: JSONL 命令 -> stdout JSON，含三类错误', () => {
  const lines = runCli(
    [
      '{"op":"join","node":"n1"}',
      '{"op":"join","node":"n2"}',
      '{"op":"join","node":"n3"}',
      '{"op":"join","node":"n1"}',
      '{"op":"write","key":"temp","value":20,"node":"n1"}',
      '{"op":"read","key":"temp"}',
      '{"op":"leave","node":"n3"}',
      '{"op":"write","key":"temp","value":21,"node":"n3"}',
      '{"op":"write","key":"temp","value":21,"node":"n1","epoch":1}',
      '{"op":"isolate","nodes":["n1","n2"]}',
      '{"op":"write","key":"x","value":1,"node":"n1"}',
      '{"op":"heal"}',
      '{"op":"repair"}',
      '{"op":"members"}',
      'not-json',
    ].join('\n') + '\n',
  );

  assert.equal(lines[0].ok, true);
  assert.equal(lines[3].idempotent, true); // 重复 join 幂等
  assert.equal(lines[4].ok, true);
  assert.deepEqual(lines[4].signers, ['n1', 'n2', 'n3']);
  const cert = lines[5].certificate;
  assert.equal(lines[5].value, 20);
  assert.equal(typeof cert.epoch, 'number');
  assert.deepEqual(cert.signers, ['n1', 'n2', 'n3']);
  assert.equal(typeof cert.vector, 'object');
  assert.equal(lines[6].tombstoned, 'n3');
  assert.equal(lines[7].error, 'NOT_MEMBER'); // tombstone 节点写被拒
  assert.equal(lines[8].error, 'EPOCH_MISMATCH'); // 旧 epoch 写被拒
  assert.equal(lines[10].error, 'QUORUM_FAIL'); // 分区后不足多数派
  assert.equal(lines[11].ok, true); // heal
  assert.equal(lines[12].ok, true); // repair
  assert.deepEqual(lines[13].tombstones, ['n3']);
  assert.equal(lines[14].ok, false);
  assert.equal(lines[14].error, 'BAD_COMMAND');
});
