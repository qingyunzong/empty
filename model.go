package dataeng

// GeomType 对应 MVT 几何编码类型（Feature.GeomType）。
type GeomType int32

const (
	GeomTypeUnknown GeomType = 0
	GeomTypePoint   GeomType = 1
	GeomTypeLine    GeomType = 2
	GeomTypePolygon GeomType = 3
)

// String 返回几何类型名称，便于日志与调试。
func (g GeomType) String() string {
	switch g {
	case GeomTypePoint:
		return "POINT"
	case GeomTypeLine:
		return "LINESTRING"
	case GeomTypePolygon:
		return "POLYGON"
	default:
		return "UNKNOWN"
	}
}

// Feature 对应 MVT Tile.Layer.Feature。
// Tags 以 [keyIndex, valueIndex, keyIndex, valueIndex, ...] 成对出现，
// 索引指向所属 Layer 的 Keys/Values 字典。
type Feature struct {
	ID       uint64
	HasID    bool
	Tags     []uint32
	Type     GeomType
	Geometry []uint32
}

// Layer 对应 MVT Tile.Layer。Extent 为 0 时按规范默认值 4096 处理，
// Version 为 0 时按规范默认值 1 处理。
type Layer struct {
	Version  uint32
	Name     string
	Features []*Feature
	Keys     []string
	Values   []Value
	Extent   uint32
}

// EffectiveExtent 返回参与归并判定的实际 extent。
func (l *Layer) EffectiveExtent() uint32 {
	if l == nil || l.Extent == 0 {
		return defaultExtent
	}
	return l.Extent
}

// EffectiveVersion 返回规范化后的 layer version。
func (l *Layer) EffectiveVersion() uint32 {
	if l == nil || l.Version == 0 {
		return defaultVersion
	}
	return l.Version
}

// Tile 是一整个 MVT tile 的内存表示。
type Tile struct {
	Layers []*Layer
}

const (
	defaultExtent  uint32 = 4096
	defaultVersion uint32 = 1
)
