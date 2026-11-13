# JSON:API included 图归并

数据连接器需要可导入的 TypeScript JSON:API 文档归并库，以 type+id 建立资源图，应用 included、links、relationships 和 sparse fieldsets。重复资源的属性冲突必须按文档来源世代裁决，缺 linkage 不臆造节点；环关系可查询但序列化保持确定顺序，并保存每个字段的来源指针。
