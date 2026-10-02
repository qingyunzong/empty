# multilateral-netting

多边净额结算库与 CLI。仅使用 Node.js 22 标准库与 `node:test`，无第三方依赖。

## 模型

- **指令（instruct）**：`{id, payer, payee, amount}`，内容寻址哈希为规范化 JSON 的 SHA-256。
- **撤销（cancel）**：`{type:"cancel", id, hash}`，引用指令 ID 与观察哈希；合并时生成墓碑，
  被撤销指令不参与净额。同一指令的并发撤销幂等（只生效一次）；撤销未知指令报 `unknown-instruction`；
  观察哈希不匹配报 `hash-mismatch`。
- **净额**：每参与方 净应付 = 累计付款 − 累计收款。
- **预算**：每参与方可设预算上限；任一净应付超过预算则批次 `blocked`，`settle` 报 `budget-exceeded`。

## 库

```js
import { Ledger } from './src/ledger.js';

const ledger = new Ledger({ budgets: { A: 50 } });
ledger.instruct({ id: 'i1', payer: 'A', payee: 'B', amount: 100 });
ledger.cancel({ id: 'i1' });            // 生成墓碑
ledger.merge([{ type: 'instruct', id: 'i2', payer: 'B', payee: 'C', amount: 40 }]);
ledger.net();                           // { B: 40, C: -40 }
ledger.certificate();                   // { status, instructions, net, budgets }
ledger.settle();                        // 超预算时抛 LedgerError('budget-exceeded')
```

## CLI

状态存于 `ledger.state.json`（可用 `--state <path>` 或 `LEDGER_STATE` 覆盖）。输入输出均为 JSON；
出错时输出 `{"error":"code"}` 且退出码为 1。

```sh
node src/cli.js instruct '{"id":"i1","payer":"A","payee":"B","amount":100}'
node src/cli.js instruct --id i2 --payer B --payee C --amount 40
node src/cli.js cancel '{"id":"i1","hash":"<observed-hash>"}'
node src/cli.js budget --party A --amount 50
node src/cli.js merge events.json      # JSON 数组 / {"events":[...]} / JSONL
node src/cli.js net
node src/cli.js settle --budget A=50 --budget B=100
node src/cli.js settle '{"budgets":{"A":50}}'
```

`settle` 成功时输出结算证书（`status: "settled"`、有效指令集合、各方净额、预算结果）；
任一净应付超预算时输出 `{"error":"budget-exceeded"}` 且退出码为 1，证书不会标记 settled。

## 测试

```sh
node --test --test-reporter spec
```
