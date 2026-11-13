# 数据血缘列级表达式传播

元数据服务要可导入的 TypeScript 列级血缘库，输入关系代数 AST，处理投影、别名、join、union、聚合、窗口与 correlated subquery。每个输出列返回源列集合及变换路径；星号按输入 schema 世代展开，歧义列不猜测。等价 AST 规范化后血缘稳定。
