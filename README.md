# TAR 稀疏文件区间重建

归档导入器要可直接接入 Go tar 稀疏映射解析库，支持 PAX GNU.sparse 版本与旧 header 表示。数据 extent 必须有序、不重叠且落在 logical size 内；空洞按零读取但不实际分配。header size 与稀疏数据消费精确匹配，后续 entry 边界不偏移。
