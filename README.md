三维渲染宿主需要供着色器准备阶段调用的C++切线生成组件，输入三角形网格的位置、逐角法线和UV，输出供着色器读取的逐角切线及手性。按UV雅可比求面切线，按角度加权累积；仅位置、法线和UV全等且手性相同的角共享累积。切线对法线作Gram-Schmidt正交化，退化UV或抵消成零时选择与法线最不平行的坐标轴构造确定后备，平局按X、Y、Z。输入法线必须为有限单位向量，零面积面不累积且沿用后备方向，数值验收误差1e-6。测试镜像UV、硬法线接缝、零面积三角形及三角形顺序重排，重建副切线须方向正确。

## 组件

`include/tangent_generator.hpp` 是仅头文件的 C++20 组件，核心接口：

- `computeTangents(corners, options)`：输入逐角 `CornerInput`（位置、法线、UV），
  输出逐角 `TangentOutput`（单位切线 `tangent` 与手性 `handedness`，取值 +1/-1）。
- 索引网格可使用 `computeTangents(positions, normals, uvs, indices, options)` 包装。
- 着色器侧用 `reconstructBitangent(frame, normal)` 重建副切线，
  即 `B = cross(N, T) * handedness`。

### 算法要点

1. 对每个三角形由 UV 雅可比求面切线 `T`，零面积面与退化（不可逆）UV 跳过累积。
2. 每角以其内角为权重累加面切线；累积键为位置、法线、UV、手性全等。
3. 手性由 `sign(det_uv * dot(几何法线, 角法线))` 决定，镜像 UV 为 -1，
   且对三角形顺序重排（含绕序翻转）保持稳定。
4. 累积切线对角法线做 Gram-Schmidt 正交化并归一化。
5. 退化 UV、零面积面或加权抵消成零时，选取与法线最不平行的坐标轴构造
   确定后备切线；坐标轴平局按 X、Y、Z 顺序。
6. 输入法线必须为有限单位向量，默认容差 1e-6，违例抛出 `std::invalid_argument`。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试覆盖：镜像 UV、硬法线接缝、零面积三角形、退化 UV、抵消后备、
三角形循环置换与绕序翻转、旋转三角形副切线方向、角度加权、索引包装和输入校验。
