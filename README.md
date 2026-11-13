# 虚拟列表滚动采集

后台页面采集器要可直接接入 TypeScript 虚拟列表遍历组件，只通过调用方提供的可见条目、滚动范围和布局事件工作。它以稳定业务键去重，检测循环与动态插入，保存已覆盖区间；容器高度变化后重新规划，直到证明无新键或达到公开预算。

## 用法

```ts
import { VirtualListCollector } from './index.js';

const collector = new VirtualListCollector<string>({
  budget: { maxSteps: 500, maxKeys: 10000 },
});

// 调用方（虚拟列表遍历组件）驱动滚动循环：
let target = collector.nextTarget();
while (target !== null) {
  scrollTo(target);
  collector.ingest(visibleEntries(), currentScrollRange());
  target = collector.nextTarget();
}
// 容器尺寸变化时：
collector.onLayout({ containerHeight: newHeight, totalSize: newTotal });

collector.keys();   // 按首次出现顺序的去重业务键
collector.status(); // done / reason / 覆盖区间 / 预算消耗
```

## 脚本

- `npm run build`：编译到 `build/`
- `npm test`：编译并运行 `node --test`
- `npm run typecheck`：仅类型检查
