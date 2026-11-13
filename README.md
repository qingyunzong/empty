# Shadow DOM 稳定定位

RPA 引擎需要可导入的 TypeScript 元素定位库，查询可穿越 open shadow root、slot 分配和 iframe，但每一步都绑定文档世代。候选重排时按语义属性与可见几何评分，分数并列必须拒绝自动点击；元素 detach 后重新定位不得误用旧句柄。
