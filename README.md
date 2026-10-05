# config-edit

保留空白与注释的配置编辑库（YAML 块式子集）。所有编辑都是**最小文本拼接**：
只触碰目标标量的词法区间或被删项自身的行，其余字节逐字节不变。

仅使用 TypeScript + Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 支持的格式子集

- 块式映射：`key: value`、`key:` + 缩进的嵌套块
- 块式序列：`- value`、`-` + 缩进的嵌套块
- 标量：plain / 单引号 / 双引号（JSON 转义）；自动类型化（null/bool/number/string）
- 注释：整行注释与尾注释（`#` 前为空白），LF 与 CRLF 行尾
- 不支持（抛 `ParseError`）：flow 集合、锚点/别名、多行标量、序列内联映射、
  tab 缩进、与父键同缩进的序列

## API

```ts
import { Config, setScalar, deleteItem, getValue, parse, toJS } from './src/index';

// 纯函数式：text in → text out
setScalar(text, ['server', 'port'], 9090);  // 只替换标量词法区间
deleteItem(text, ['server', 'legacy']);     // 删除项，尾注释移到前一存活项
getValue(text, ['server', 'port']);

// 状态式封装
const cfg = Config.parse(text);
cfg.set(['a'], 1);        // 路径不存在 → 返回 false，不修改
cfg.delete(['b']);        // 路径不存在 → 返回 false，不修改
cfg.toJS(); cfg.toString();
```

## 编辑语义

- **修改标量**：仅替换该标量的词法区间（span）。空值（`key:`）在冒号后插入
  ` value`。新值序列化为能重解析回原值的最简 token（必要时加引号）。
  目标是容器时抛错。
- **删除项**：精确移除该项自身的内容行（含嵌套子树），行间无关注释/空行保留。
  被删项首行的尾注释以两个空格追加到前一存活兄弟项的末行；没有前驱时丢弃。
  删除最后一个子项后父级重解析为 `null`（YAML 语义）。
- **不存在的路径**：`setScalar` / `deleteItem` 原样返回输入文本，不做任何修改。
- **重解析正确性**：每次编辑后重新解析，树值与对 JS 模型施加同样操作的结果一致。

## 测试

```
npm test    # tsc 编译 + node --test
SEED=42 npm test   # 换随机种子
```

- `test/config.test.ts`：21 个确定性用例（区间替换、注释迁移、缺失路径、
  CRLF、引号、错误路径等）。
- `test/random.test.ts`：随机核对——40 个随机文档 × 60 个随机操作
  （set/缺失 set/容器 set 抛错/delete/缺失 delete），每个操作后断言：
  set 的前后缀逐字节不变；delete 与独立重建的期望文本完全一致；
  重解析树值与模型一致（空容器归一化为 null）。

## 实际测试结果

```
$ npm test
> tsc -p tsconfig.json && node --test dist/test/*.test.js
# Subtest: dist/test/config.test.js
ok 1 - dist/test/config.test.js
# Subtest: dist/test/random.test.js
ok 2 - dist/test/random.test.js
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# duration_ms ~420
```

随机核对另以种子 1, 7, 42, 999, 31337, 20261006 复跑，全部通过（pass 6 / fail 0）。
