# 列裁剪嵌套 field id

查询规划器需要可导入的 TypeScript 嵌套列裁剪库，从表达式、过滤器和重建需求计算 struct/list/map 的 field-id 路径。选择 map value 不得丢 key；数组元素为空仍保留容器层级。schema 演进名称变化不改变 id 绑定，未知 id 明确失败。
