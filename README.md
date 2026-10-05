# descparse — 描述式二进制解析库

用 JSON 描述二进制格式，库负责解析。支持：字段长度引用前字段、条件出现、
嵌套数组、命名类型引用（定义图循环拒绝）、长度乘法防溢出，出错时游标恢复
到结构起点。提供读取 CLI，并以随机描述对「编译式解析器」与「直接格式解释器」
做差分核对。

仅使用 TypeScript + Node.js 内置库（`node:buffer` / `node:fs` / `node:test` 等），
无第三方运行时依赖。

## 描述格式（Schema）

```jsonc
{
  "types": {
    "Packet": {
      "kind": "struct",
      "fields": [
        { "name": "payloadLen", "type": { "kind": "uint", "bits": 16, "littleEndian": true } },
        { "name": "payload", "type": { "kind": "bytes", "length": { "ref": "payloadLen" } } },
        { "name": "checksum", "type": { "kind": "uint", "bits": 32 }, "when": { "field": "flags", "equals": 1 } }
      ]
    }
  },
  "root": "Packet"
}
```

类型节点：

| kind     | 说明                                                                 |
| -------- | -------------------------------------------------------------------- |
| `uint`   | `{ kind:"uint", bits:8\|16\|32, littleEndian?:boolean }`，默认大端   |
| `bytes`  | `{ kind:"bytes", length: number \| { ref:"字段" } }`，输出为 Buffer  |
| `array`  | `{ kind:"array", count: number \| { ref:"字段" }, element: 类型 }`   |
| `struct` | `{ kind:"struct", fields: [...] }`，字段按序解析，输出为对象         |
| `ref`    | `{ kind:"ref", name:"命名类型" }`                                    |

语义规则：

- **长度引用前字段**：`{ "ref": "n" }` 可出现在 `bytes.length` / `array.count`，
  引用同一 struct 中**先前解析的无条件 uint 字段**（`struct` 是作用域边界，
  `array` 不是，因此数组元素内可引用外层 struct 的字段）。
- **条件出现**：字段带 `when: { field, equals }` 时，仅当同 struct 先前的
  无条件 uint 字段值 `=== equals` 才解析；未命中时输出对象中不含该键。
- **嵌套数组**：`array.element` 可为任意类型节点（含 `array`、`struct`、`ref`）。
- **定义图循环拒绝**：命名类型引用图存在环（自引用、间接引用、经数组元素）
  时，`validateSchema` 抛 `SchemaError`，消息含环路径，如
  `definition cycle detected: A -> B -> A`。
- **长度乘法防溢出**：单项长度/计数及 `count × 元素大小` 不得超过
  `MAX_LENGTH`（2^31−1），否则抛 `ParseError("overflow")`；元素大小未知或
  为 0 时计数不得超过 `MAX_DYNAMIC_ITEMS`（1,000,000），防止空转循环。
  固定布局的乘积/求和溢出在 schema 校验期即拒绝（`SchemaError`）。
- **出错游标恢复**：`struct`/`array` 解析失败时，游标恢复到该结构起点再
  向上抛出；`parse()` 返回的 `offset` 即恢复后的位置，`error.at` 记录失败
  实际发生处。

## CLI

```bash
npm run build          # 编译到 dist/
node dist/src/cli.js <schema.json> <data.bin> [--engine compile|interpret] [--offset N]
```

- 成功：stdout 输出 `{ ok:true, offset, value }`（`bytes` 以 hex 字符串表示），退出码 0
- 数据解析失败：stdout 输出 `{ ok:false, offset, error }`，退出码 1
- 用法或 schema 错误：stderr 输出原因，退出码 2

示例（`examples/packet.schema.json` 演示长度引用、条件出现、命名类型数组、大小端）：

```bash
$ node dist/src/cli.js examples/packet.schema.json examples/packet.bin
{
  "ok": true,
  "offset": 23,
  "value": {
    "magic": 43981,
    "version": 1,
    "flags": 1,
    "payloadLen": 3,
    "payload": "414243",
    "checksum": 16909060,
    "tagCount": 2,
    "tags": [
      { "id": 1, "textLen": 2, "text": "6869" },
      { "id": 2, "textLen": 3, "text": "686579" }
    ]
  }
}
```

## API

```ts
import { parse } from "./src/parse.js";

const result = parse(schema, buffer, { engine: "compile", offset: 0 });
// engine: "compile"（默认，编译为闭包）| "interpret"（直接树走解释器）
// 成功: { ok:true, value, offset }  失败: { ok:false, error:{code,message,at}, offset }
// schema 非法时抛 SchemaError
```

## 测试

```bash
npm test               # tsc 编译 + node --test
```

测试内容：

- `test/unit.test.ts`：大小端、长度引用、条件出现、嵌套数组与命名类型、
  定义图循环拒绝、各类非法定义、长度乘法防溢出、出错游标恢复、CLI 行为
  （成功 / 截断失败 / 循环 schema / 用法错误，双引擎输出一致）。
- `test/differential.test.ts`：差分核对。按种子生成随机合法 schema
  （1–3 个命名类型，引用仅向前保证无环）与匹配的随机数据，再施加截断与
  随机字节翻转，要求编译式解析器与直接格式解释器在成功值、结束偏移、
  错误码、恢复后游标上完全一致。

### 实际运行结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

```
$ npm test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

ok 1 - dist/test/differential.test.js     # differential cases: 1755 (ok=1122, err=633), seeds=1..300
ok 2 - dist/test/unit.test.js             # 9 个单元测试全部通过
# tests 2
# pass 2
# fail 0
```

单元测试明细（全部 ok）：

```
ok 1 - uint 大小端与偏移推进
ok 2 - 字段长度引用前字段
ok 3 - 条件出现：when 命中才解析
ok 4 - 嵌套数组与命名类型引用
ok 5 - 定义图循环拒绝
ok 6 - 非法定义：引用与形状错误
ok 7 - 长度乘法防溢出
ok 8 - 出错游标恢复到结构起点
ok 9 - CLI：读取示例并核对双引擎一致
```

## 目录结构

```
src/schema.ts      描述格式类型定义
src/validate.ts    schema 校验（引用、作用域、循环拒绝、静态尺寸溢出）
src/checked.ts     防溢出长度运算（MAX_LENGTH / MAX_DYNAMIC_ITEMS）
src/cursor.ts      解析游标
src/compile.ts     编译式解析器（主引擎）
src/interpret.ts   直接格式解释器（差分核对用参照实现）
src/parse.ts       公共 API：parse / readerFor
src/cli.ts         读取 CLI
test/gen.ts        随机 schema / 数据生成器（种子确定性）
test/unit.test.ts  单元测试
test/differential.test.ts  差分核对测试
examples/          示例 schema 与数据
types/node.d.ts    所用 Node 内置模块的最小类型声明（环境无 @types/node）
```
