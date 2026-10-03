# RESULTS — 组17 离线结算目录双向同步

环境：Node.js v22.22.1，仅标准库 + node:test，单机离线，无第三方依赖。

## 实现概览

- 文件键：`商户|日期|币种`，由 `<merchant>_<YYYY-MM-DD>_<CCY>.csv` 解析（`lib/keys.js`）。
- 更新判定：内容 SHA-256 + 每键 mtime 向量 `{a,b}`，状态存于各目录 `.sync/state.json`（`lib/state.js`）。
- 删除：墓碑（`deleted:true` + 最后内容哈希），双向传播。
- 冲突：同键双向不同内容 → conflict，plan 不含该键任何 op，禁止按目录先后静默赢；冲突来源（`no-common-ancestor` / `both-modified` / 双复活不同新版本）写入 diff 输出。
- 计划最小性：每个可行动键恰好一个 op；已收敛键零 op。
- 可中断：64KB 分块复制，每块 fsync 后原子更新 journal（`<plan>.journal.json`）；恢复时从 `confirmedBytes` 偏移续写，已确认块不重拷；目标哈希已一致则整体跳过（幂等）。
- 错误码：只读目标 `code=60`；墓碑复活无新版本 `code=61`。

## 验收结果（真实运行）

### 命令

```
node --test test/*.test.js
node cli.js diff|plan|apply|resolve --a DIR_A --b DIR_B [--plan FILE] [--key K --winner a|b]
```

### 测试套件（node --test test/*.test.js）

```
1..5
# tests 5
# pass 5
# fail 0
# duration_ms ~48000
```

### 1) 200 文件含改删，A→B 与 B→A 收敛哈希相同 — test/convergence.test.js

- 场景：200 键 = 120 共有基线 + 40 仅 A 新增 + 40 仅 B 新增；基线同步后 30 改于 A、30 改于 B、20 删于 A、20 删于 B。
- diff 实测：copy 140、delete 40、conflict 0、error 0；plan ops = 180（最小）。
- apply 实测：`copied:140, deleted:40`；`dirHash(A) == dirHash(B)`；两侧各 160 个 CSV，40 个墓碑写入双方 state。
- 二次 apply：`copied:0, deleted:0`（幂等）。
- 镜像场景（参数顺序对调）最终哈希相同。

### 2) 同键冲突生成同一 conflict 证书，内容保持双份 — test/conflict.test.js

- 无共同祖先 / both-modified 两种来源均检出并解释；plan 对冲突键零 op，apply 后双方原内容不变（无静默赢）。
- resolve 后：证书 `certHash = sha256(key + 排序后的双哈希)`，与方向无关——交换 A/B 内容角色、从另一侧 resolve，得到完全相同的证书 JSON（实测 certHash `3b958c22…db22d` 在 diff 与 resolve 输出中一致）。
- 内容双份：胜出版本写入两目录规范名，败出版本以 `<key>.conflict-<hash8>.csv` 存于两目录；证书写入两目录 `.sync/conflicts/`。

### 3) 复制到一半 kill，resume 不重复已确认块 — test/resume.test.js

- 4MB 文件、64KB 块、15ms/块延迟，在 worker 线程中 apply，journal 确认 ≥3 块后 `worker.terminate()` 硬杀（等同 SIGKILL，无清理）。
- kill 后 journal：`status:"in-progress", confirmedBytes ≥ 196608`。
- resume 实测：`resumedFrom ≥ 196608`，`bytesWritten == size - resumedFrom`，`resumedBytes == resumedFrom`——已确认块零重拷；最终内容一致，第三次运行 `copied:0`。

### 4) n≤7 枚举文件状态对照 plan 最小性 — test/minimality.test.js

- 22 行单键真值表（prev ∈ {无, v1, 墓碑(v1)} × A/B ∈ {无, v1, v2, 新版本}）逐一核对 op 数、冲突数、错误数。
- n=1..7 对 6 个代表场景做全组合枚举（共 6^1+…+6^7 = 335,922 组）：plan op 总数 == 各键最小 op 数之和；无重复键 op；收敛键零 op；每个可行动变更恰好被一个 op 覆盖。全部通过。

### 错误码（真实 CLI 运行）

- 只读目标：`chmod 555 B && node cli.js apply --a A --b B` → `error: read-only target: /tmp/demo3/B`，`exit=60`，B 中零文件写入。
- 墓碑复活无新版本：墓碑建立后以原内容重建文件 → `node cli.js diff` 输出 `code:61` 错误项并 `exit=61`；以新内容复活则正常传播（`resurrected-in-a-new-version`）。

## 备注

- 沙箱禁止 spawn 子进程，测试通过 `require('../cli').run` 进程内调用 CLI（同一入口，`node cli.js ...` 行为一致，已用真实进程验证 diff/plan/apply/resolve 及 60/61 退出码）；kill 场景用 worker 线程 terminate 实现真实硬中断。
- `.sync/`（状态、journal、证书）与 `*.conflict-*.csv` 旁车文件不参与键扫描。
