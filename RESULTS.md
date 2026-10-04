# RESULTS

## 环境

- Node.js 版本：`v22.22.1`（`node --version`）
- 平台：Linux x86_64，仅标准库，无第三方依赖

## 测试命令与结果

真实执行命令：

```sh
node --test
```

输出摘要（TAP）：

```
ok 1 - test/cert.test.js
ok 2 - test/e2e.test.js
ok 3 - test/fuzz.test.js
ok 4 - test/helpers.js
ok 5 - test/lexer.test.js
ok 6 - test/parser.test.js
ok 7 - test/scope.test.js
ok 8 - test/types.test.js
# tests 8
# pass 8
# fail 0
```

通过 8 / 失败 0（共 8 个测试文件，含全部子测试）。

## CLI 冒烟验证（真实执行）

```sh
node bin/settle.js run examples/rules.stl examples/input.json --cert out.json
# => {"ok":true,"flows":3,"cert":"out.json"}   退出码 0

node bin/settle.js verify examples/rules.stl examples/input.json --cert out.json
# => {"ok":true,"flows":3}                     退出码 0
```

错误路径示例（真实执行，退出码均为 1）：

```
let x: money = 1.005m;
# => {"code":"E_LEX","message":"money literal '1.005m' has more than 2 decimal places","line":1,"col":16}

let r: rate = -0.05;
# => {"code":"E_TYPE","message":"negative rates are not allowed","line":1,"col":15}
```

## 验收对照

1. 三类规则（fee/tax/net）跑通且证书可重放验证：`test/e2e.test.js`
   （run 产出证书，verify 重放比对成功；篡改证书后 verify 失败）。
2. 金额 `1.005m` → `E_LEX`（`test/lexer.test.js`）；负税率 → `E_TYPE`
   （`test/types.test.js`）；重复 `let` → `E_SCOPE`、未绑定变量 → `E_SCOPE`
   （`test/scope.test.js`）。
3. 100 笔随机流水与独立四舍五入参考实现逐笔对照：`test/fuzz.test.js`
   （确定性种子 mulberry32(20261004)，另含 0.5 分精确边界的 half-up 用例）。
4. 修改一条规则仅受影响条目证书变化：`test/cert.test.js`
   （改 tax 规则后 `rule_hashes.tax` 变化，`fee`/`net` 不变，
   `rules_hash`/`bytecode_hash` 变化，`input_hash` 与结果不变）。
