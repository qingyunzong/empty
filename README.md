# Schema drift 字段身份跟踪

采集平台要可直接接入 TypeScript schema drift 状态库，根据稳定 field id、路径、类型和来源提示跟踪 rename、move、split 与 merge 候选。自动接受只限无歧义兼容变化；多个候选时保留待决图。规则批准形成新世代，历史记录仍用旧 schema 解释。
