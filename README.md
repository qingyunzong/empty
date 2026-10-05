# authz-session-snapshot

鉴权会话库：会话快照绑定策略版本。长事务可继续读旧权限，但提交时必须用策略库
**最新版本** 重核事务记录的全部写动作；任一写动作重核失败则整个事务中止，
**全不提交**（原子性）。仅使用 TypeScript + Node.js 内置模块，零外部运行时依赖。

## 核心语义

| 阶段 | 使用的策略版本 |
| --- | --- |
| 会话打开 `openSession()` | 绑定当时的最新版本（快照） |
| 会话内读 `can()` / 暂存写 `stageWrite()` | 会话绑定的快照（旧版本，长事务期间稳定可读） |
| 事务提交 `commit()` | 提交时刻的**最新版本**，重核全部写动作 |

- 重核全部通过 → 所有写一次性落库。
- 任一写被拒 → 全部写都不落库，返回 `revocationHits`（旧允许 → 新拒绝的撤销命中证据）。

## 文件

- `src/authz.ts` — 核心库：`PolicyStore`（版本化策略）、`AuthSession`（快照绑定）、
  `Transaction`（写动作记录 + 提交重核）、`DataStore`（原子落库）、`formatEvidence`（证据格式化）
- `src/simulation.ts` — 策略撤销与提交交错的模拟，打印旧/新命中证据
- `test/authz.test.ts` — `node:test` 测试（7 个用例）
- `types/node.d.ts` — 内置模块最小类型声明（无 `@types/node` 依赖）
- `TEST_RESULTS.md` — `npm test` 与模拟的实际运行输出

## 命令

```sh
npm test           # 编译 + 运行全部测试
npm run simulate   # 运行撤销/提交交错模拟，输出旧新命中证据
```
