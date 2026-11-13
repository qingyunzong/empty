# XML namespace 事件规范化

异构数据入口要可直接接入 Go XML 事件规范化库，解析 namespace scope、默认命名空间、属性前缀和 xml:base，输出 expanded name 与原始位置。前缀重绑定只作用于子树，未声明前缀拒绝当前文档；实体展开被禁用但预定义实体可用。随机切块事件相同。
