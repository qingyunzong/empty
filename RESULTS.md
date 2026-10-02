# 组17: 离线结算目录双向同步 — 实现与真实结果

环境: Node.js v22.22.1, 仅标准库 + node:test, 单机离线, 无第三方依赖。

## 结构

- `lib/util.js` — sha256 / 稳定序列化 / 文件键解析 (`商户_日期_币种.csv` → `merchant|date|currency`)
- `lib/core.js` — 目录扫描、`.sync/state.json` 状态与墓碑、`diff` 分类、冲突证书、最小 plan (纯函数 `planFromData`)
- `lib/apply.js` — 幂等执行: 分块复制 + 每块确认日志 (journal) + 原子 rename, 断点续传, 状态合并
- `lib/resolve.js` — 冲突解决: `keep-both` (默认) / `a` / `b`, 双份内容保留 + 确定性 证书
- `cli.js` — `node cli.js diff|plan|apply|resolve --a DIRA --b DIRB`
- `test/*.test.js` — 6 个测试文件

## 机制要点

- 更新判定: 内容哈希为主, 状态条目记录 mtime 向量 `vec:{a,b}` 用于归因解释
- 删除: 墓碑 (`{deleted:true, hash}`) 写入两侧 `.sync/state.json`, 删除沿墓碑传播
- 冲突: 同键双向不同内容 → `conflict` 操作, apply 跳过 (禁止按目录先后静默赢); 证书对两侧内容哈希排序后定址, 与目录参数顺序无关
- 中断恢复: 每块写盘+fsync+落 journal 才算已确认; 恢复时截断到 confirmedBytes 后续传, 已完成操作整体跳过
- 错误码: 只读目标 `code=60`; 墓碑复活无新版本 `code=61`

## 验收结果 (真实运行)

### 1) 200 文件含改删, A→B 与 B→A 收敛哈希相同 — 通过

`test/convergence.test.js`: 140 基准 + 新增 30/30 + 修改 15/15 + 删除 5/5 = 200 键。
从同一初始发散分别执行 sync(A,B) 与 sync(B,A), 四个目录哈希全等; 收敛后 190 文件;
操作数 = 100 (60 新增 + 30 修改 + 10 删除); 二次同步 0 操作 (幂等)。

### 2) 同键冲突生成同一 conflict 证书, 内容保持双份 — 通过

`test/conflict.test.js`: plan(A,B) 与 plan(B,A) 的 `certId` 相同
(实测 `c1058a7e…9b67`, 见下方 CLI 演示); apply 不覆盖任何一侧 (退出码 2);
`resolve --strategy keep-both` 后两侧各持有 `<base>.<hash8>.csv` 双份内容 +
逐字节相同的 `<base>.conflict.json`, 目录哈希收敛, 再 diff 0 操作。

### 3) 复制到一半 kill, resume 不重复已确认块 — 通过

`test/resume.test.js`: file1=3 块 + file2=20 块 (chunk=256B), `SYNC_KILL_AFTER_CHUNKS=8`
模拟 kill (退出码 75), journal 记录 file2 已确认 5 块/1280B; resume 时 trace 显示
首块 idx=5, 仅补 15 块, idx 0..4 与 file1 未重传; 第三次 apply 全部 skipped。

### 4) n≤7 枚举文件状态对照 plan 最小性 — 通过

`test/minimality.test.js`: n=1..3 全 8 状态 (eq/onlyA/onlyB/updA/updB/conflict/delA/delB)
+ n=4..7 全 5 状态枚举, 共 **98084** 种组合逐一验证:
操作数 == 需动作键数 (eq 零操作)、每键至多一个操作且类型/方向正确、planHash 确定。

### 错误码 — 通过

`test/errors.test.js`: 目标目录 chmod 555 → 库抛 `SyncError code=60`, CLI 退出 60;
删除同步后以相同内容复活 → `code=61` (库抛出 + CLI 退出 61); 以新内容复活 → 正常 copy。

## 测试运行记录

命令: `node --test test/*.test.js`

```
# tests 6
# pass 6
# fail 0
# duration_ms 78533.7 (本机沙箱 CPU 较慢; minimality 单文件约 20-34s)
```

## CLI 演示实录 (2026-10-03, /tmp/demo)

```
$ node cli.js diff --a A --b B
  changes: [conflict m001|2026-09-15|CNY (both-modified, certId=c1058a7e…9b67),
            copy m003|2026-09-15|USD b→a "仅 B 端存在该键(新增)"], unchanged: 1
$ node cli.js apply --a A --b B --journal j1.json
  {"copied":1,"conflicts":1,...}  → 退出码 2 (存在未解决冲突, 不静默取胜)
$ node cli.js resolve --a A --b B --strategy keep-both
  {"resolved":1,"certIds":["c1058a7e…9b67"]}   # 与 diff 阶段 certId 一致
$ ls A B   # 两侧相同: m001…be0606ec.csv + m001…dd86359b.csv (双份内容)
           #          + m001….conflict.json (相同证书) + m002/m003 正常文件
$ node cli.js diff --a A --b B
  changes: 0  unchanged: 3  errors: 0          # 收敛
```

## 备注

- 本沙箱中 node 孙进程的管道 stdout/stderr 会被吞掉, 测试内 CLI 调用改用文件重定向捕获
  (`test/helpers.js: runCli`), 不影响库与 CLI 本身。
- 冲突证书与解释不含挂钟时间, 完全由 (key, kind, 基准哈希, 双方内容哈希+mtime) 决定, 保证方向无关性。
