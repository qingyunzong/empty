# spatial-index

C++20 标准库实现的 MVCC 空间索引(仅头文件,无第三方依赖)。

## 语义约定

- **半开 AABB**:`Box<Dims>` 表示 `[min, max)`。仅在边界上相触(面、棱、角)
  不算相交;点包含同样半开(`min <= p < max`)。见 `include/spatial/aabb.hpp`。
- **零体积忽略**:任一维度 `min >= max` 即为空盒。空盒的 upsert 是 no-op,
  空查询范围不匹配任何对象。
- **批次移动原子**:`commit()` 将整批 upsert/remove 一次性发布:基于新逻辑
  状态构建不可变快照(批量加载的 kd 树,节点存子树包围盒),单次原子交换
  生效。读者要么看到整批,要么一点都看不到。
- **旧快照查询合法**:`open_view()` 返回的 `View` 钉住当前纪元并指向一个
  不可变快照,其生命周期内视图不变——后续的删除、ID 复用、批次提交都不
  影响它。
- **屏障回收**:被替换的快照退休(retire)到纪元域,只有当所有读者都越过
  静止态(取消钉住或以更新纪元重新钉住)后,`collect()` 这道屏障才会真正
  释放内存。每个 `View` 拥有独立的读者记录,同一线程可安全持有多个视图。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build -j
cd build && ctest --output-on-failure
```

## 测试组成(CMake/CTest)

| 测试 | 内容 |
| --- | --- |
| `aabb` | 半开相交/包含语义:贴面、贴棱、贴角不相交;零体积永不相交 |
| `zero_volume` | 零体积 upsert 被忽略、零体积更新为 no-op、空查询范围无命中 |
| `snapshot` | 批次移动原子性;旧视图在删除与 ID 复用后仍保持原状 |
| `reclamation` | 屏障回收:读者钉住时不回收、越障后回收、新读者不阻塞旧回收、多代一起回收(以存活快照计数验证) |
| `model_crosscheck` | 随机化全扫描模型核对:2D/3D 随机批次(含零体积、整数坐标制造大量贴边)后,索引查询结果与暴力全扫描逐一比对;钉住的旧视图与其旧模型同样核对 |
| `concurrent` | 1 写 4 读并发:每个视图必须观察到完整单一世代(批次原子性),回收并发进行 |

## 实际测试结果(2026-10-06,g++ 15.2.0,CMake 4.2.3)

普通构建(RelWithDebInfo,`-Wall -Wextra -Wpedantic` 零警告):

```
1/6 Test #1: aabb .............................   Passed    0.01 sec
2/6 Test #2: zero_volume ......................   Passed    0.01 sec
3/6 Test #3: snapshot .........................   Passed    0.01 sec
4/6 Test #4: reclamation ......................   Passed    0.01 sec
5/6 Test #5: model_crosscheck .................   Passed    0.02 sec
6/6 Test #6: concurrent .......................   Passed    0.02 sec

100% tests passed, 0 tests failed out of 6
```

- `concurrent` 额外连跑 10 次全部通过。
- AddressSanitizer 构建(`-fsanitize=address`,关闭沙箱内不可用的 LeakSanitizer):6/6 通过。
- ThreadSanitizer 构建(`-fsanitize=thread`):6/6 通过。

## 布局

```
include/spatial/aabb.hpp   半开 AABB 与相交/包含谓词
include/spatial/epoch.hpp  纪元屏障回收域(EBR)
include/spatial/index.hpp  MVCC 空间索引(kd 树快照 + 原子发布)
tests/                     CTest 测试(自带极简测试框架)
```
