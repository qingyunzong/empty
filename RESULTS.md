# RESULTS

日期: 2026-10-04
环境: Node.js v22.22.1,Linux x86_64,仅标准库 + `node:test`
命令: `node --test`(工作区根目录)

## 真实运行输出(摘要)

```
ok 1 - test/acceptance.test.js
ok 2 - test/crc32.test.js
ok 3 - test/helpers.js
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 33573.328879
```

`test/acceptance.test.js` 子测试(真实运行输出):

```
ok 1 - acceptance 1: append 3 events, restart, query by deviceId+seq, duplicate rejected
ok 2 - acceptance 2: fault injection durability boundaries
ok 3 - acceptance 3: fault-prefix enumeration for <=6 records matches reference algorithm
ok 4 - acceptance 3b: corrupt tails are truncated, matching reference algorithm
```

## 验收项覆盖

1. **正常写入三事件后重启**:CLI 子进程依次 append 3 个事件,全新进程
   (触发恢复 + 索引重建)按 `deviceId+seq` 查询,结果与写入一致;
   重复 `eventId` 写入返回 `E_DUP`(exit 2),重启后重复写入仍被拒绝。
2. **三类故障点注入**:`crash --fault after_data|after_sync|after_commit`
   (exit 101 模拟崩溃)后 `recover`:
   - `after_data`、`after_sync` → 事件不可见(`get` 返回 `E_NOTFOUND`,exit 3)
   - `after_commit` → 事件必须可见且内容一致
   恢复后可继续追加,可见性结论在再次重启后保持稳定。
3. **≤6 条记录的故障前缀枚举**:对 n = 0..6 条已提交记录 × 3 个故障点
   共 21 种崩溃前缀,恢复结果与朴素参考算法(只保留含有效提交标记的
   最长前缀,`test/helpers.js` 中独立实现)逐事件一致;补充 3b:
   n = 0..6 × 5 种尾部损坏(垃圾字节 / CRC 错误 / 截断头 / 截断负载 /
   未提交帧)共 35 种,均按不完整截断且与参考算法一致,截断后可继续追加。

## 备注

- 本沙箱中 `spawnSync` 的 `input` 选项及孙进程的异步 `process.stdout`
  写入会丢失数据,因此 CLI 输出统一使用 `fs.writeSync(1, ...)` 同步写,
  测试通过临时文件描述符喂 stdin。这不影响库本身的逻辑。
- 修复过的关键 bug:WAL 不能以 `O_APPEND` 打开,否则提交标记的原位
  覆写会被追加到文件末尾。
