# Protobuf schema 演进字段归属

数据契约服务会调用可导入的 TypeScript protobuf 演进判定库，比较字段号、wire type、oneof、map entry、reserved 与 enum 开放性。判定区分向后、向前和双向兼容，并返回最小破坏路径；字段改名但号不变与重用已删除号要给不同结论。
