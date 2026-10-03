# batch-lineage

批次谱系追溯库与 CLI。Node.js 22，仅标准库，单机离线，测试基于 `node:test`。

## 模型

- **DAG**：节点为批次，边为用料关系（parent 用料 → child 产品）。
- **事件日志**：仅追加（append-only）JSONL，三类事件 `add` / `correct` / `delete`，
  携带非递减 `ts`；乱序时间拒绝并抛 `E_TIME`。
- **时间截面**：查询按 `--at N` 重放 `ts <= N` 的事件，旧截面永远不变。
- **更正**：`correct --child C --from A --to B` 产生反向补偿（删旧边、加新边、
  为 child 签发新证书版本），历史保留。若 `child`/`to` 尚不存在，更正进入
  **未决队列**，依赖到达后增量生效——未决不等于不可满足。会成环的更正抛 `E_CYCLE`。
- **删除**：`delete` 打墓碑位。谱系/检索结果中墓碑节点被屏蔽（列入 `masked`，
  遍历穿透），但删除可由证书证明。
- **备注索引**：位置倒排索引，支持精确短语 `--phrase "a b"` 与邻近
  `--near "a b" --dist 3`（NEAR/3）。
- **证书**：每节点每次变更签发一版证书 = H(id | 父证书哈希 | 文本哈希 | 墓碑位 | 版本)，
  全部证书哈希进入 Merkle 日志，`prove` 输出包含证明，`verify` 校验，
  失败抛 `E_PROOF`。

## 错误码

`E_CYCLE`（成环）· `E_TIME`（乱序时间）· `E_PROOF`（证明无效）· `E_INPUT`（输入非法）

## CLI

```sh
node src/cli.js --db log.jsonl add --id A --text "stainless steel rod" --ts 1
node src/cli.js --db log.jsonl add --id B --parents A --text "welded frame" --ts 2
node src/cli.js --db log.jsonl correct --child B --from A --to D --ts 3
node src/cli.js --db log.jsonl ancestors --id B --at 2     # 旧截面
node src/cli.js --db log.jsonl descendants --id A
node src/cli.js --db log.jsonl search --phrase "steel rod"
node src/cli.js --db log.jsonl search --near "steel frame" --dist 3
node src/cli.js --db log.jsonl delete --id B --ts 4
node src/cli.js --db log.jsonl cert --id B                 # tombstone: 1
node src/cli.js --db log.jsonl prove --id B                # inclusion 证明
node src/cli.js --db log.jsonl verify --proof '<json>'
node src/cli.js --db log.jsonl root
```

## 库

```js
import { Ledger } from './src/ledger.js';
const l = new Ledger();
l.append({ type: 'add', id: 'A', parents: [], text: '...', ts: 1 });
l.ancestors('B', 5);        // { live: [...], masked: [...] }
l.searchPhrase('steel');    // 同上结构
l.prove('B');               // { leaf, index, path, root, cert }
Ledger.verifyProof(proof);  // boolean，畸形证明抛 E_PROOF
```

## 测试

```sh
node --test
```

覆盖验收四项：1) 祖先/后代枚举与索引过滤暴力对照；2) 更正后旧截面不变、
新截面更新、未决更正延迟生效；3) 删除屏蔽与墓碑证书可证；4) 环与乱序时间
报 `E_CYCLE` / `E_TIME`，证明篡改报 `E_PROOF`。真实结果见 `TEST-RESULTS.txt`。
