# dataeng

可嵌入 C++20 的空间坐标批变换组件。零第三方依赖，只使用标准库，适合在数据管线中直接链接。

核心能力：

- 显式 CRS 定义：大地基准、椭球、投影、轴序、角度单位、有效域。
- 地理坐标轴序：`LongitudeLatitude` / `LatitudeLongitude`。
- 角度单位：度 / 弧度，仅作用于地理坐标；投影坐标始终为米。
- 投影：Transverse Mercator（Krüger 六阶级数）与 Web Mercator。
- 动态 datum：参考历元 Helmert 参数 + 每年变化率，支持逐点历元覆盖。
- 逐点失败隔离：失败点返回独立 `Status` 与 `NaN` 输出，不影响同批其他点。
- 往返校验：按 CRS 声明的公开误差界限检查 ECEF 弦长误差。

## 构建与测试

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

## 快速使用

```cpp
#include "dataeng.hpp"

using namespace dataeng;

Crs source = Crs::wgs84(AxisOrder::LatitudeLongitude);
Crs target = Crs::utm(50, true);  // UTM 50N, axis order 默认 E/N

Transformer transformer(source, target, 2025.0);

std::vector<Point> batch = {
    {31.2304, 121.4737, 0.0},  // first=latitude, second=longitude
    {31.2000, 121.5000, 10.0},
    {95.0000, 121.5000, 0.0},  // 纬度越界，仅此点失败
};

std::vector<PointResult> results = transformer.transform(batch);
for (const PointResult& result : results) {
    if (result.ok()) {
        // UTM 输出：first=easting, second=northing, height 为椭球高
        use(result.first, result.second, result.heightMeters);
    } else {
        log(statusMessage(result.status));
    }
}
```

`Crs::wgs84()`、`Crs::utm()`、`Crs::webMercator()` 是便捷构造器。其他 CRS 可直接填写 `Crs` 结构。`identifier`（如 `EPSG:4326`）只是元数据，**不会覆盖显式 `axisOrder`**；调用方必须按输入数据实际轴序设置。

## 语义约定

### 轴序与单位

| CRS 类型 | 允许的轴序 | 坐标含义 |
| --- | --- | --- |
| Geographic | `LongitudeLatitude`, `LatitudeLongitude` | 经度、纬度 |
| Projected | `EastingNorthing`, `NorthingEasting` | 东坐标、北坐标，米 |

地理坐标的角度单位由 `Crs::angularUnit` 指定。例如 `LatitudeLongitude + Degrees` 表示 `Point.first` 是纬度（度），`Point.second` 是经度（度）。输入和输出分别使用各自 CRS 的轴序与角度单位。

`Point::heightMeters` 始终是椭球高（米），不是正高。本组件不包含大地水准面模型。

### 有效域

`Crs::domain` 定义：

- 地理纬度、经度范围；
- 椭球高范围；
- 投影坐标范围（可选）；
- 投影相对中央经线的最大偏移。

行为：

- 地理 CRS 的输入经度必须落在声明的经度区间内，不做静默环绕；`181°` 不会自动变成 `-179°`。
- 投影 CRS 会反投影后检查地理域，也会检查 `Northing/Easting` 是否落在可选投影范围内。
- 目标经度若在目标域中存在等价表示（例如目标域为 `[0, 360]`，内部结果为 `-10°`），会输出为 `350°`；不存在等价表示则标记 `OutOfDomain`。
- UTM 便捷构造器默认使用纬度范围 `-80°..84°` 与中央经线 `±3°`；如需严格按半球或更窄作业区限制，可直接收窄 `Crs::domain`。
- Web Mercator 默认限制在 `±85.0511287798°`。

### 动态 datum

```cpp
Crs dynamic = Crs::wgs84(AxisOrder::LongitudeLatitude);
dynamic.datum.hasTransformToWgs84 = true;
dynamic.datum.referenceEpoch = 2010.0;
dynamic.datum.transformToWgs84 = {
    10.0, -20.0, 30.0,   // tx, ty, tz: 米
    0.1, -0.2, 0.3,      // rx, ry, rz: 角秒
    0.5                  // scale: ppm
};
dynamic.datum.ratesPerYear = {
    1.0, 0.0, -0.5,      // 米/年
    0.001, 0.0, 0.0,     // 角秒/年
    0.01                 // ppm/年
};
dynamic.datum.minEpoch = 1980.0;
dynamic.datum.maxEpoch = 2050.0;
```

历元 `t` 的参数按线性模型计算：

```text
p(t) = p(referenceEpoch) + ratesPerYear * (t - referenceEpoch)
```

变换器构造时给定批默认历元，`Point::epoch` 可逐点覆盖。动态 datum 的历元超出 `[minEpoch, maxEpoch]` 时该点返回 `EpochOutOfRange`。Helmert 使用 EPSG 9606 position-vector 约定，反向变换通过矩阵求逆完成，而非简单取反。

### 失败隔离

每个点独立执行纯函数式变换。`Transformer` 不保存逐点状态；批量接口仅按顺序收集结果。失败点：

- `PointResult::status` 为具体错误；
- `first`、`second`、`heightMeters` 均为 `NaN`；
- 后续点继续正常处理。

状态包括：

| Status | 含义 |
| --- | --- |
| `Ok` | 成功 |
| `InvalidConfiguration` | CRS 或变换器配置非法 |
| `NonFiniteInput` | 坐标含 `NaN` / `Inf` |
| `NonFiniteEpoch` | 历元非有限值 |
| `EpochOutOfRange` | 动态 datum 历元越界 |
| `OutOfDomain` | 坐标超出 CRS 有效域 |
| `ProjectionError` | 反投影/投影失败或结果非有限 |
| `DatumError` | Helmert 参数或矩阵求逆失败 |
| `NumericError` | ECEF/大地坐标数值转换失败 |
| `RoundTripToleranceExceeded` | 往返误差超过声明界限 |

### 往返校验

每个 CRS 的 `roundTripToleranceMeters` 即该 CRS 对外声明的往返/作业误差界限。

```cpp
RoundTripReport report = transformer.verifyRoundTrip(point);
if (!report.ok()) {
    // report.status, report.errorMeters, report.toleranceMeters
}
```

- `Transformer::verifyRoundTrip` 执行 `source -> target -> source`，在源 CRS 椭球下计算原始点与回返点的 ECEF 弦长误差。
- 默认容差为 `source.roundTripToleranceMeters + target.roundTripToleranceMeters`；也可传入管线自身的公开容差。
- `verifyCrsRoundTrip(crs, point, epoch)` 单独验证 CRS 内部数学：地理 CRS 做 `地理 -> ECEF -> 地理`，投影 CRS 做 `投影 -> 地理 -> 投影`，不掺入 datum 变换误差。
- 任一变换环节失败时报告携带该环节的具体 `Status`；误差超界时状态为 `RoundTripToleranceExceeded`。

## 数值实现

- 大地坐标与 ECEF 使用 WGS84 椭球参数化及迭代反算。
- Transverse Mercator 使用 Krüger 六阶级数，包含纬度原点偏移，支持自定义中央经线、比例因子和假东/假北。
- Web Mercator 使用球面等角投影公式，作用在 WGS84 长半轴上。
- 动态 datum 使用一阶时间相关 Helmert（EPSG 9606 position-vector）。
- 投影往返误差在 UTM / Web Mercator 典型范围内通常小于 `1e-6 m`；具体判定以 CRS 声明界限为准。

## 适用范围与限制

- CRS 采用结构化定义，不解析 WKT/PROJ 字符串，也不内置 EPSG 数据库。
- 每个 datum 只有一条到 WGS84 的变换；不支持任意基准变换图或分带选择。
- 动态部分为线性参数率模型，不包含完整板块运动模型或速度场插值。
- 不含正高/大地水准面、垂直基准或时间相关坐标插值。
- 需要严格 EPSG 权威轴序时，请显式使用 `AxisOrder::LatitudeLongitude`；便捷构造器的默认轴序面向常见 GIS `x=lon, y=lat` 调用习惯。
