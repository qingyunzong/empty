# Multilateral Netting

多边净额结算库与 CLI，仅使用 Node.js 22 标准库与 `node:test`。

## 库（src/netting.js）

- `createState()` 创建副本状态 `{ instructions, cancels }`。
- `addInstruction(state, { id, payer, payee, amount })` 增量接收付款指令；同 id 同内容幂等，同 id 不同内容抛 `conflicting-instruction`。
- `cancelInstruction(state, id, observedHash?)` 生成墓碑；重复撤销幂等（`applied: false`），未知指令抛 `unknown-instruction`，观察哈希不符抛 `hash-mismatch`。
- `mergeState(state, other)` 合并另一副本的指令与撤销事件并生成墓碑。
- `computeNets(state)` 每个参与方净应付 = 累计付款 - 累计收款（被撤销指令不参与）。
- `settle(state, budgets)` 生成结算证书：有效指令集合、各方净额、预算结果；任一净应付超过预算则 `status: "blocked"`，否则 `"settled"`。

指令哈希为 `{amount, id, payee, payer}` 规范 JSON 的 SHA-256。

## CLI（cli.js）

状态存于 JSON 文件（默认 `netting-state.json`，可用 `--state` 指定）。

```sh
node cli.js instruct --state s.json --id i1 --payer alice --payee bob --amount 100
node cli.js cancel   --state s.json --id i1 --hash <observedHash>
node cli.js merge    --state s.json other-replica.json
node cli.js net      --state s.json
node cli.js settle   --state s.json --budgets '{"alice":100,"bob":200}'
```

- 全部输出为 JSON；`settle` 超预算时 stdout 输出 `blocked` 证书，stderr 输出 `{"error":"budget-exceeded"}`，退出码 1。
- 其他错误输出 `{"error":"<code>"}` 到 stderr，退出码 1（`unknown-instruction`、`hash-mismatch`、`conflicting-instruction`、`invalid-input`）。

## 测试

```sh
node --test --test-reporter spec > result.txt 2>&1; echo $? >> result.txt
```
