# 字符串 collation 排序键

数据清洗引擎需要可直接接入 C++ 版本化 collation key 组件，调用方提供 locale、strength、normalization 和规则版本。排序键只在相同配置世代比较；原字符串作为最终并列键保证全序。无效 UTF-8 按策略隔离，升级规则不重用旧索引。
