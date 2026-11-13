# 缺失值语义映射

异构数据入口要可导入的 TypeScript 缺失值归一组件，按字段 schema 区分 absent、null、empty、NaN、sentinel 和 redacted。映射规则版本化且保留原始表示；不允许把合法零值或空集合当缺失。输出值、缺失类别和规则证据，支持无损回查。
