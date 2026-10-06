# photo-organize

按给定映射批量重命名照片的 CLI。TypeScript 编写，仅使用 Node.js 内置库
（`node:fs` / `node:path` / `node:crypto` / `node:test` 等），无第三方依赖。

## 功能

- **映射重命名**：`mapping.json` 描述 `{from, to}` 列表（也接受对象形式 `{"a.jpg": "b.jpg"}`）。
- **环交换借助临时名**：交换 / 轮换（a↔b、a→b→c→a）自动检测，先改名为
  `.photo-tmp-<journalId>-<n>-<name>` 临时名再完成环，结束后无临时文件残留。
- **大小写折叠按输入规则比较**：映射中的 `"caseFold": true|false`（默认 `true`）决定
  冲突比较是否折叠大小写；`true` 时 `A.jpg` 与 `a.jpg` 视为同名。
- **预检任一冲突整批拒绝**：重复源、重复目标、源缺失、目标被批外文件占用、
  无操作重命名、路径逃逸工作目录、目标父目录缺失——任一冲突即整批拒绝，
  不产生任何改名、不写日志，退出码 2。
- **持久日志，任意步可中断**：计划先整体写入 `.photo-organize.journal.json`，
  每步执行前记 `doing`、执行后记 `done`（临时文件 + 原子 rename 落盘）。
  任意步骤崩溃后 `apply` 即可断点续跑。
- **恢复不覆盖未知文件**：恢复时逐步核对日志与磁盘；目标位置出现未知文件、
  源意外消失等不一致即中止（退出码 4），绝不覆盖。
- **核对两次恢复及逆计划**：`verify` 模拟每个可能的崩溃点（每步的
  doing 落盘后 / rename 后两个窗口）执行恢复，断言能到达最终态，且**第二次
  恢复恒为空操作**；并把全部步骤逆序回放（逆计划），断言精确还原初始状态。
  `rollback` 用逆计划真正撤销一批已完成的改名。

## 使用

```sh
npm run build          # tsc -> dist/
node dist/src/cli.js plan mapping.json --dir /photos
node dist/src/cli.js apply --dir /photos     # 执行或断点续跑
node dist/src/cli.js verify --dir /photos    # 核对：日志vs磁盘、两次恢复、逆计划
node dist/src/cli.js rollback --dir /photos  # 逆计划回滚
node dist/src/cli.js status --dir /photos
```

退出码：`0` 成功；`1` 一般错误；`2` 预检冲突；`3` 核对失败；`4` 恢复中止（发现未知文件等）。

## 结构

- `src/mapping.ts` — 映射解析与预检（大小写折叠比较）
- `src/plan.ts` — 计划构建：拓扑排序 + 环检测 + 临时名；逆计划生成
- `src/journal.ts` — 日志读写（原子落盘）、归档
- `src/recover.ts` — 日志与磁盘/虚拟视图的逐步核对（恢复核心）
- `src/executor.ts` — 执行器：记日志、执行、断点续跑
- `src/verify.ts` — 核对：实时一致性、全崩溃点两次恢复模拟、逆计划回放
- `src/commands.ts` / `src/cli.ts` — 命令层与 CLI 入口
- `types/node.d.ts` — Node 内置库的本地类型声明（环境无 `@types/node`）

## 测试

```sh
npm test    # tsc -p tsconfig.json && node --test dist/test/*.test.js
```

实际运行结果（Node v22.22.1，TypeScript 7.0.2，2026-10-06）：

```
# dist/test/plan.test.js    tests 13  pass 13  fail 0
# dist/test/recover.test.js tests 10  pass 10  fail 0
# dist/test/cli.test.js     tests 4   pass 4   fail 0
# 合计 27 个测试全部通过（npm test 退出码 0）
```

覆盖：简单/链式/交换/轮换重命名、临时名无残留、大小写折叠开与关、
各类预检冲突整批拒绝、doing 窗口与 done 窗口崩溃续跑、未知文件不覆盖、
两次恢复幂等、逆计划回滚还原、篡改检测、CLI 退出码。
