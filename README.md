# CAN 总线多帧信号重组

车载数据入口需要可嵌入的 C++ 多帧重组状态库，按 arbitration id、counter、cycle 和 DBC 世代组合帧并解码信号。丢帧、重复计数和 counter 回绕分别判定；超时输出缺口证据。配置热更新不混用两个布局。
