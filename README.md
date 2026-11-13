# YAML anchor 图预算

配置采集服务需要可导入的 TypeScript YAML 1.2 表示图构建库，支持 anchor、alias、merge key 与重复键策略，同时限制别名展开成本。保留共享节点而非深复制，循环 alias 给出路径；merge 后字段来源可追溯，显式键覆盖顺序确定。
