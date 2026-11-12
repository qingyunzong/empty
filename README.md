# 复制位点区间集合的规范化与差集

复制采集器要把已经应用到的事务位点保存成可比较文本，输入里的重复、相邻区间和大小写不能各算一种位点。实现可导入的TypeScript模块，供位点账本调用，不连接数据库。输入不得含空白，空串是空集合；逗号分节，空节拒绝。每节以32位十六进制SID和冒号开头，A至F不区分大小写，规范SID用小写。冒号后先读取到下一个冒号或结尾：该片段若是区间，本节就没有标签，余下全部内容都是冒号分隔的区间；否则片段是标签，后面必须还有冒号和区间。区间为无前导零十进制n或n-m，满足1<=n<=m<=9223372036854775807，单独0、前导零和n>m都拒绝。标签由字母或下划线开头，后接零至31个字母、数字或下划线，区分大小写。同一SID的无标签区间与不同标签互不合并。同一命名空间内闭区间按精确整数合并，[a,b]与[c,d]在c<=b+1时合并；b已是9223372036854775807时禁止再加一判断相邻。5-5的规范写法是5，1-2:4保持不变，1-2:3合并成1-3，同一命名空间重复出现的节先合并。规范文本按SID字典序、再按标签字典序排列，空标签在前；组内区间按起点升序，单点写n，跨度写n-m，区间用冒号连接。无标签写sid:intervals，有标签写sid:tag:intervals，组间用逗号。模块提供解析、并集、交集、差集、单事务包含和子集判断，解析失败返回字节偏移。差集要拆区间，1-10去掉4-6得到1-3:7-10，且不得改变另一标签或无标签区间。编号全程用精确整数。测试把事务号限制在1至64，用独立集合展开对照四种运算；同时覆盖SID大小写、标签与纯数字区间的分界、相邻合并、最大端点、前导零、空节和差集拆开。期望集合不得通过调用被测模块的规范化结果反推。

## API

`index.ts` 无数据库或运行时依赖，事务端点一律使用 `bigint`。

- `parse(text)` 返回 `{ ok: true, value }` 或 `{ ok: false, offset, error }`；`offset` 是零基 UTF-8 字节偏移。
- `stringify(set)` / `normalize(text)` / `format(input)` 输出规范文本。
- `union(...inputs)`、`intersection(...inputs)`、`difference(a, ...subtrahends)` 返回规范文本；`intersect`、`subtract`、`minus` 是别名。
- `contains(input, transaction)`、`contains(input, sid, transaction)`、`contains(input, sid, label, transaction)` 判断单事务包含。
- `isSubset(candidate, superset)` 判断候选集合是否完全被覆盖；`subset` 是别名。
- 所有接受集合的函数都可接收规范文本、`parse` 的成功结果，或 `{ groups }` 结构。

```ts
import { difference, normalize } from "./index.js";

const sid = "0123456789abcdef0123456789abcdef";

normalize(`${sid.toUpperCase()}:5-5:6-8`);
// "0123456789abcdef0123456789abcdef:5-8"

difference(`${sid}:1-10`, `${sid}:4-6`);
// "0123456789abcdef0123456789abcdef:1-3:7-10"
```
