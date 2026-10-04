# interval-edits

基于同一原文的半开区间替换编辑库（TypeScript + Node.js 内置库，无运行时依赖）。

## 语义

- 编辑为半开区间替换 `{ start, end, text }`：`[start, end)` 被 `text` 替换；
  `start === end` 为纯插入，`text === ''` 为纯删除。
- 所有编辑基于**同一原文**坐标，一次 `applyEdits(original, edits)` 全部生效。
- **重叠拒绝**：非空区间相互重叠、或插入点严格落在被替换区间内部时抛 `RangeError`；
  相邻区间（`prev.end === next.start`）与边界插入合法。
- **同点插入按请求序**：同一位置的多个插入按传入顺序依次拼接。
- **双向位置映射**：
  - `mapForward(pos, affinity)`：原文位置 → 新文位置；
  - `mapBackward(pos, affinity)`：新文位置 → 原文位置；
  - 被删除/替换区间**内部**的位置按亲和绑定边缘：`'left'`（默认）绑定到替换文本起点
    （逆向为原区间左边缘），`'right'` 绑定到终点（逆向为原区间右边缘）；
  - 插入点处：左亲和落在插入文本之前，右亲和落在所有同点插入之后；
  - 接缝（多段共用的边界位置）逆向映射取左侧段。

## 使用

```ts
import { applyEdits } from './src/edits.ts';

const r = applyEdits('abcde', [{ start: 1, end: 4, text: 'XY' }]);
r.text;                    // 'aXYe'
r.mapForward(2, 'left');   // 1  删除内部 -> 左边缘
r.mapForward(2, 'right');  // 3  删除内部 -> 右边缘
r.mapBackward(2, 'left');  // 1  替换文本内部 -> 原左边缘
```

## 测试

```sh
npm test   # tsc 编译 + node --test 运行 dist/test/edits.test.js
```

测试内容：

- **枚举核对**：对长度 0–3 的原文，枚举全部单编辑（所有 `[i,j)` × 替换文本
  `''/'X'/'YZ'`）与全部有序双编辑组合；重叠组合必须抛错，合法组合核对：
  结果文本与参考实现一致；保留区间内部位置满足 `backward∘forward = id` 与
  `forward∘backward = id`；删除内部按亲和绑定边缘且替换文本内部逆向回到原边缘。
- 专项：同点插入请求序、重叠/相邻/边界插入、非法区间、删除坍缩、插入点亲和、文末位置。

## 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - 枚举：短文本上全部单编辑与双编辑组合，核对文本与映射复合
ok 2 - 同点插入按请求顺序生效
ok 3 - 重叠区间拒绝，相邻区间接受
ok 4 - 非法区间与越界位置抛错
ok 5 - 删除内部位置按左/右亲和绑定边缘
ok 6 - 纯删除坍缩到同一点
ok 7 - 插入点位置的双向亲和
ok 8 - 文末位置映射
# tests 8
# pass 8
# fail 0
```

注：本机 Node 构建未启用类型剥离（`ERR_NO_TYPESCRIPT`），故 `npm test` 先用
`tsc` 编译到 `dist/` 再运行；`types/node-shim.d.ts` 为离线环境下
`node:test` / `node:assert` 的最小类型声明，安装 `@types/node` 后可删除。
