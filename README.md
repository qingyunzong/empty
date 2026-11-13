# Pulsar 游标回退与批消息确认

消息接入服务要嵌入可导入的 TypeScript Pulsar 游标组件，处理 ledger/entry/batchIndex、累积确认、单条否认和 topic 截断。批消息只在全部子项终态后推进持久游标；重投与游标回退不重复确认新世代消息，返回可核对的未决区间。
