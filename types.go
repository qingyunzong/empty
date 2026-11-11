package q259

import "errors"

// 流级错误。所有对 Decoder 的非法输入都会返回这些哨兵错误的包装值，
// 调用方可用 errors.Is 判定具体原因。
var (
	// ErrInvalidObject 表示对象总长度不足、游程数据或尺寸非法。
	ErrInvalidObject = errors.New("q259: invalid object definition")
	// ErrInvalidFragment 表示分片偏移、长度或重叠内容不合法。
	ErrInvalidFragment = errors.New("q259: invalid object fragment")
	// ErrInconsistentFragment 表示与已接收片段重叠的字节不一致。
	ErrInconsistentFragment = errors.New("q259: inconsistent overlapping fragment")
	// ErrInvalidPalette 表示调色板版本或内容不合法。
	ErrInvalidPalette = errors.New("q259: invalid palette")
	// ErrInvalidDisplayList 表示显示列表引用非法（缺对象/缺调色板）。
	ErrInvalidDisplayList = errors.New("q259: invalid display list")
	// ErrNotReady 表示收到结束标记时对象或调色板尚未齐备。
	ErrNotReady = errors.New("q259: display list not ready")
	// ErrOutOfBounds 表示对象画布区域越界，整次合成被拒绝。
	ErrOutOfBounds = errors.New("q259: object placement out of bounds")
	// ErrPinned 表示待显示列表仍引用该对象或调色板，无法回收。
	ErrPinned = errors.New("q259: entry pinned by pending display list")
)

// Color 是 8 位直连 RGBA（非预乘），预乘在合成时完成。
type Color struct {
	R, G, B, A uint8
}

// Palette 是某一版本的 256 色调色板。TransparentIndex 为 -1 时表示
// 没有透明索引；否则该索引的像素跳过，不覆盖底图。
type Palette struct {
	// Version 是调色板版本号，显示列表按版本固定引用。
	Version uint32
	// Entries 按索引保存颜色；未覆盖的条目保持透明黑。
	Entries [256]Color
	// TransparentIndex 是透明索引，-1 表示无透明索引。
	TransparentIndex int
}

// NewPalette 创建指定版本、无透明索引的空调色板。
func NewPalette(version uint32) *Palette {
	return &Palette{Version: version, TransparentIndex: -1}
}

// ObjectFragment 是对象定义的一个分片。同一对象定义以 (ID, Version)
// 标识，各分片按 Offset 拼接，总长由 TotalLength 固定；重叠区间的字节
// 必须完全一致。
//
// 拼接后的定义布局为大端：
//
//	uint16 width
//	uint16 height
//	byte[] rle  // 逐行游程
//
// 每行由若干 (count, index) 字节对组成，count 为 0 表示该行结束。
type ObjectFragment struct {
	ID          uint16
	Version     uint32
	TotalLength uint32
	Offset      uint32
	Data        []byte
}

// DisplayObject 是显示列表中的一个放置项，固定引用对象版本与调色板版本。
type DisplayObject struct {
	ObjectID       uint16
	ObjectVersion  uint32
	PaletteVersion uint32
	X, Y           int
}

// DisplayList 是一次合成的完整显示列表，仅当所有引用齐备并收到结束
// 标记时才会被合成。
type DisplayList struct {
	Width   int
	Height  int
	Objects []DisplayObject
}
