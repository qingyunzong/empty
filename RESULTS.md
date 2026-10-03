# RESULTS

- Node 版本：`v22.22.1`
- 日期：2026-10-03

## 测试

真实命令（仓库根目录）：

```bash
node --test
```

结果：**7 个测试文件全部通过，0 失败**（`# tests 7 / # pass 7 / # fail 0`）。

逐文件展开共 **43 个测试用例，43 通过 / 0 失败**：

| 文件 | 通过 | 失败 |
| --- | --- | --- |
| test/lexer.test.js | 9 | 0 |
| test/parser.test.js | 8 | 0 |
| test/checker.test.js | 9 | 0 |
| test/vm.test.js | 7 | 0 |
| test/cli.test.js | 6 | 0 |
| test/acceptance.test.js | 4 | 0 |

逐文件复核命令：`node test/<name>.test.js`（TAP 输出 `# pass` 计数）。

## CLI 冒烟

```bash
node bin/settle.js run examples/rules.stl examples/input.json --cert /tmp/results-cert.json
# 退出码 0，stdout 输出 3 笔流水的 fee/tax/net（如 t-001: fee 1.50, tax 0.09, net 998.41）
node bin/settle.js verify examples/rules.stl examples/input.json --cert /tmp/results-cert.json
# 退出码 0，输出 {"ok": true, "steps": 21}（证书重放验证通过）
```

## 验收标准对应

1. 三类规则（fee/tax/net）跑通且证书可重放验证 — `test/acceptance.test.js` acceptance 1 + 上述 CLI 冒烟。
2. `1.005`→`E_LEX`、负税率→`E_TYPE`、重复 `let`→`E_SCOPE`、未绑定变量→`E_SCOPE` — acceptance 2。
3. 100 笔随机流水与独立四舍五入参考实现逐笔对照 — acceptance 3。
4. 修改一条规则后仅受影响批次证书变化（未受影响批次证书逐字节一致）— acceptance 4。
