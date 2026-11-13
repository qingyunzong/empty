# DuckDB replacement scan 快照绑定

嵌入式查询层需要可嵌入的 C++ replacement scan 绑定组件，将外部表名解析为版本化 schema 和扫描句柄。bind 阶段固定快照；执行期间目录更新不改变列布局。句柄取消与查询析构竞争时资源只释放一次，错误包含解析世代。
