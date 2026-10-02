# repro-dag

实验复现管理 DAG:登记步骤、输入哈希与证据证书;重跑时只失效受影响的后代。
纯 Node.js 22 标准库实现,无第三方依赖。

## 结构

- `src/dag.js` — 核心库(状态为可序列化 JSON 对象)
- `cli.js` — 命令行,状态持久化到 `dag.state.json`(可用 `--state` 覆盖)
- `test/dag.test.js` — `node:test` 验收测试
- `RESULTS.md` — 真实测试与演示输出

## CLI

```sh
node cli.js add        '{"id":"extract","codeVersion":"1","inputs":[],"params":{}}'
node cli.js run        '{"id":"extract"}'      # 或 '{"all":true}'
node cli.js invalidate '{"id":"extract"}'
node cli.js audit
node cli.js gc
```

错误以 `{"error":{"code":"CYCLE"|"MISSING_INPUT"|"BAD_CERT"}}` 输出到 stderr,退出码 1。

## 核心设计

- **因果 DAG**:`add` 时校验输入存在(`MISSING_INPUT`)且无环(`CYCLE`);
  重复 `add` 同一 id 视为"更正",精确失效自身+全部传递后代。
- **缓存键**:`sha256(codeVersion, inputHash, ancestorVector)`,
  其中祖先向量为全部传递祖先缓存键的排序数组,因此祖先更正必然改变后代键。
- **证据证书**:每次运行向全局哈希链追加一环
  `hash = sha256(seq, prev, nodeId, key, outputHash)`;
  `audit` 先验证链完整性,再对每个有效条目从根到叶重算缓存键并核对证书,
  任何篡改报 `BAD_CERT`。
- **tombstone + gc**:`invalidate` 只打墓碑不删除;`gc` 仅物理移除
  所有运行者(持有有效缓存条目的 pinned head)都确认不可达的墓碑条目,
  因此 `audit` 结果在 gc 前后保持一致。

## 测试

```sh
node --test
```
