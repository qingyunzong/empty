// Package locate 根据多个传感器给出的坐标矩形范围与置信权，
// 计算被至少 k 个范围覆盖的可行区域；当可行区域为空时，
// 给出需要剔除的最小冲突子集（总置信权最小），使剩余传感器恢复一致。
//
// 约束：传感器数量最多 18 个（冲突子集按子集枚举，2^18 可承受）。
package locate

// Rect 为轴对齐矩形。规范化后满足 MinX <= MaxX 且 MinY <= MaxY。
type Rect struct {
	MinX, MinY, MaxX, MaxY float64
}

// R 构造规范化矩形，自动交换颠倒的坐标。
func R(minX, minY, maxX, maxY float64) Rect {
	if minX > maxX {
		minX, maxX = maxX, minX
	}
	if minY > maxY {
		minY, maxY = maxY, minY
	}
	return Rect{MinX: minX, MinY: minY, MaxX: maxX, MaxY: maxY}
}

// Empty 报告矩形是否没有正面积。
func (r Rect) Empty() bool { return r.MaxX <= r.MinX || r.MaxY <= r.MinY }

// Area 返回矩形面积（退化矩形为 0）。
func (r Rect) Area() float64 {
	if r.Empty() {
		return 0
	}
	return (r.MaxX - r.MinX) * (r.MaxY - r.MinY)
}

// Contains 报告点 (x, y) 是否在矩形内（含边界）。
func (r Rect) Contains(x, y float64) bool {
	return x >= r.MinX && x <= r.MaxX && y >= r.MinY && y <= r.MaxY
}

// ContainsRect 报告矩形 o 是否完全落在 r 内（含边界）。
func (r Rect) ContainsRect(o Rect) bool {
	return o.MinX >= r.MinX && o.MaxX <= r.MaxX && o.MinY >= r.MinY && o.MaxY <= r.MaxY
}

// Sensor 描述一个定位传感器给出的范围与置信权。
type Sensor struct {
	ID     string
	Rect   Rect
	Weight float64 // 置信权，越大越可信
}

// Region 为一块可行区域及其来源传感器 ID（升序）。
type Region struct {
	Rect    Rect
	Sources []string
}
