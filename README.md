# Arrow C Data 所有权桥接

插件边界需要可嵌入的 C++ Arrow C Data 生命周期桥接库，管理 schema/array release 回调、child、dictionary 和 sliced buffer 所有权。导入成功后每个回调恰好调用一次；部分导入失败按已取得所有权回滚。跨线程释放不发生双重释放或悬挂引用。
