// 验收场景演示: 输出即 README 中记录的真实结果。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verify, replay } from './src/verify.js';
import { SegmentLog, recover } from './src/log.js';
import { truncateAt } from './src/fault.js';

const cmd = (name) => ({ type: 'cmd', name });
const ack = (sensor, value) => ({ type: 'ack', sensor, value });
const show = (title, obj) => console.log(`\n== ${title} ==\n` + JSON.stringify(obj, null, 2));

// 场景1: 升温未达压强却开排汽
const h1 = [cmd('LOCK_DOOR'), ack('DOOR', 'LOCKED'), cmd('START_HEAT'), ack('PRESSURE', 'LOW'), cmd('OPEN_EXHAUST'), cmd('STOP_HEAT')];
show('场景1 升温未达压强开排汽', verify(h1));

// 场景2: 未知 ack 不判安全
const h2 = [cmd('LOCK_DOOR'), cmd('START_HEAT'), cmd('OPEN_EXHAUST')];
show('场景2 PRESSURE 未知时开排汽', verify(h2));

// 场景3: 故障点1 写完data未写commit -> 丢弃该批
let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retort-demo-'));
let log = new SegmentLog(dir);
log.cmd('LOCK_DOOR');
log.commit();
log.cmd('START_HEAT');
log.ack('PRESSURE', 'LOW');
log.commit({ fault: 'after-data' });
let rec = recover(dir);
show('场景3 故障点1(data无commit)恢复', { segments: rec.segments, records: rec.records, replay: replay(rec.records).safeState });

// 场景4: 故障点2 写完commit未写manifest -> 整批可见
dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retort-demo-'));
log = new SegmentLog(dir);
log.cmd('LOCK_DOOR');
log.commit();
log.cmd('START_HEAT');
log.ack('PRESSURE', 'OK');
log.commit({ fault: 'after-commit' });
rec = recover(dir);
show('场景4 故障点2(commit无manifest)恢复', { segments: rec.segments, manifestRebuilt: rec.manifestRebuilt, records: rec.records, replay: replay(rec.records).safeState });

// 场景5: 字节截断 -> ERR_CORRUPT
dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retort-demo-'));
log = new SegmentLog(dir);
log.cmd('LOCK_DOOR');
log.commit();
log.cmd('START_HEAT');
log.commit();
const f = path.join(dir, 'seg-000002.data');
truncateAt(f, fs.statSync(f).size - 12);
rec = recover(dir);
show('场景5 截断故障注入', { segments: rec.segments, errors: rec.errors, records: rec.records });
