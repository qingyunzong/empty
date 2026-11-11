# 资源策略组件（Resource Policy Component）

浏览器可导入的 TypeScript ESM 组件，根据调用方给出的页面 origin、多个策略对象、
待加载 URL 与资源类型，判定一次子资源加载应被允许还是拒绝，并返回参与判定的策略索引。

## 构建与测试

```bash
npm run build   # tsc 编译到 dist/
npm test        # 编译测试并使用 node:test 运行（无需联网、无需第三方依赖）
```

运行环境自带全局 `typescript` 与 Node 内置测试运行器；本环境的 Node 二进制不能直接
执行 `.ts`，因此测试先经 `tsconfig.test.json` 编译到 `build-test/` 再运行。

## 用法

```ts
import { PageLoadAdapter, evaluateResource } from "./dist/index.js";

const policies = [
  { default: ["'self'"], script: ["https://cdn.example.test/app"] },
  { script: ["*.cdn.example.test", "cdn.example.test"] },
];

// 适配器：每个页面构造一次，加载路径上只做匹配
const adapter = new PageLoadAdapter("https://shop.example.test", policies);
adapter.canLoadScript("https://cdn.example.test/app/x.js");
adapter.canLoadImage("//img.example.test/p.png"); // 协议相对 URL 继承页面协议

// 或一次性函数式调用
const verdict = evaluateResource(
  "https://shop.example.test",
  policies,
  "/assets/main.js",
  "script",
);
// => { allowed: boolean, allowedBy: number[], deniedBy: number[] }
```

## 策略模型

- 指令仅含 `default`、`script`、`img` 三类；源项为字符串数组。
- `script`/`img` 缺省时回退到 `default`；两者都缺省时该策略对该资源类型不限制。
- 单个策略内多个源项取并集（任一匹配即允许）；多个策略之间取交集（任一拒绝即整体拒绝）。
- `'none'` 必须独占：与其它源项混用时该指令失效并按拒绝处理（fail-closed）。

## 源项类型

- `'none'`：拒绝全部；`'self'`：匹配页面 origin（协议、主机、端口完全一致）。
- scheme 源项，如 `https:`、`data:`：只比较协议。
- host 源项，如 `example.test`、`*.example.test`、`https://host:8443/app`：
  - 未给 scheme 时使用页面 scheme；未给端口时使用该 scheme 的默认端口
    （http/ws=80、https/wss=443、ftp=21），因此省略端口与显式默认端口等价。
  - `*.example.test` 只匹配子域（`a.example.test`、`a.b.example.test`），
    不匹配裸域 `example.test`；不带通配符时要求主机完全相等。
  - 可选路径前缀在“单次百分号解码 + 消除点段”后按整段前缀比较，
    因此 `/app` 匹配 `/app/x.js` 但不匹配 `/apple`。

## URL 与路径处理

- 支持绝对 URL、协议相对 URL（`//host/...`）与相对路径，后两者基于页面 origin 解析。
- 路径先做恰好一次百分号解码，再按 RFC 3986 消除 `.`/`..` 点段，然后按段比较前缀。
- 遇到坏转义（如 `%ZZ`、`%2`）直接拒绝该资源，即使其它条件本应允许。
- 双重编码（`%252F`）只解码一层，不会被当作路径分隔符。

## 返回值

`PolicyVerdict.allowed` 为所有策略均允许时才为真；`allowedBy`/`deniedBy` 分别给出
允许或拒绝该资源的策略在入参数组中的索引，便于调用方定位多策略冲突来源。

## 测试覆盖（页面加载适配器）

`test/adapter.test.ts` 与 `test/url.test.ts` 覆盖：默认端口等价、协议相对 URL、
通配根域仅匹配子域、编码斜杠与坏转义、点段消除、多策略交集与冲突索引、
`'none'` 独占、`'self'`、scheme/host 源项及指令回退。
