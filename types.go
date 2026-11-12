package dataeng

import "io"

// ValueType 标识宿主在 new 索引中声明的通道样本类型。
type ValueType uint8

const (
	// TypeI16 是 2 字节有符号整数。
	TypeI16 ValueType = 1
	// TypeI32 是 4 字节有符号整数。
	TypeI32 ValueType = 2
	// TypeF64Bits 是 8 字节 IEEE-754 double 的原始位型，
	// 包内不做任何十进制浮点转换，只原样返回 uint64 位型。
	TypeF64Bits ValueType = 3
	// TypeTimestamp 是 16 字节 TDMS 时间戳：先 uint64 亚秒分量，
	// 再 int64 秒分量，两个分量均按所在段的端序解码。
	TypeTimestamp ValueType = 4
)

// Width 返回类型的固定字节宽度：i16=2、i32=4、f64bits=8、timestamp=16。
func (t ValueType) Width() int {
	switch t {
	case TypeI16:
		return 2
	case TypeI32:
		return 4
	case TypeF64Bits:
		return 8
	case TypeTimestamp:
		return 16
	default:
		return 0
	}
}

func (t ValueType) valid() bool { return t.Width() != 0 }

// Endian 是段头声明的字节序。段内每个活动通道的固定端序都必须等于它。
type Endian uint8

const (
	// LittleEndian 表示低有效字节在前。
	LittleEndian Endian = 1
	// BigEndian 表示高有效字节在前。
	BigEndian Endian = 2
)

// IndexKind 是一次通道更新的三选一索引语义。
type IndexKind uint8

const (
	// IndexNew 给出类型与每 chunk 正样本数 n，建立或更新该路径的索引缓存。
	IndexNew IndexKind = 1
	// IndexReuse 沿用该路径最近一次 new 的完整索引，本身不带类型和 n。
	IndexReuse IndexKind = 2
	// IndexNone 表示该通道本段无原始数据，但不删除最近一次 new 的缓存。
	IndexNone IndexKind = 3
)

// Update 是宿主解析段头后给出的一条有序通道更新。
//
// Path 是宿主提供的非空 UTF-8 通道身份，本包把它当作不透明字符串，
// 不解析路径文本，也不在不同路径之间借用索引。
// Kind 为 IndexNew 时 Type 与 SamplesPerChunk 必须有效；
// 为 IndexReuse 或 IndexNone 时 Type 与 SamplesPerChunk 被忽略。
type Update struct {
	Path            string
	Kind            IndexKind
	Type            ValueType
	SamplesPerChunk int64
}

// RawLayout 声明段内原始区的字节布局。
type RawLayout uint8

const (
	// LayoutContiguous：每个 chunk 内按活动顺序先存一个通道的全部 n 个
	// 样本，再存下一个通道；各通道的 n 可以不同。
	LayoutContiguous RawLayout = 1
	// LayoutInterleaved：每个 chunk 内按样本序号轮流存各活动通道的一个
	// 值，要求所有活动通道的 n 相同，但不要求类型宽度相同。
	LayoutInterleaved RawLayout = 2
)

func (l RawLayout) valid() bool { return l == LayoutContiguous || l == LayoutInterleaved }

// Segment 是一次段提交的全部输入。宿主负责解析 TDMS 式段头与元数据，
// 本包只消费解析结果与原始字节。
//
// SegmentNumber 必须是唯一且严格递增的段号；失败的段不占用段号，
// 修正后可以用原段号重试，已提交的段号再次输入一律拒绝。
//
// Reader 与 RawLength 描述不可变原始区：Reader 支持按绝对物理字节偏移
// 随机读取，RawLength 是该段原始区长度；读取单个样本不会全文件读入。
// RawOffset 是原始区起点在 Reader 地址空间中的物理字节偏移，
// 来源上报的物理字节均为该地址空间中的绝对偏移。
type Segment struct {
	SegmentNumber int64
	Endian        Endian
	NewList       bool
	Layout        RawLayout
	Updates       []Update

	Reader    io.ReaderAt
	RawOffset int64
	RawLength int64
}

// Budget 是引擎的硬预算。零值不合法，必须通过 New 显式给出正数上限；
// 超预算与寻址乘法溢出都在读取前拒绝。
type Budget struct {
	// MaxChannelsPerSegment 限制单段活动通道数。
	MaxChannelsPerSegment int
	// MaxChunksPerSegment 限制单段原始区允许的 chunk 数。
	MaxChunksPerSegment int64
	// MaxCachedIndexes 限制可同时缓存 new 索引（按路径）的数量。
	MaxCachedIndexes int
}

// Timestamp 是 TypeTimestamp 解码后的两个原始分量。
//
// Fraction 是无符号 2^64 定标亚秒分量，Seconds 是有符号秒分量。
// 精确秒值为 Seconds + Fraction/2^64；本包同时保留原始分量，
// 调用方可按需做精确有理数换算，包内不强制走十进制浮点。
type Timestamp struct {
	Fraction uint64
	Seconds  int64
}

// Source 记录单个样本来自哪一段、哪个 chunk 以及物理字节区间。
// PhysicalOffset 是传入 Segment.Reader 地址空间中的绝对字节偏移，
// 区间为 [PhysicalOffset, PhysicalOffset+Width)。
type Source struct {
	SegmentNumber  int64
	Chunk          int64
	LogicalIndex   int64
	PhysicalOffset int64
	Width          int
}

// Result 是读取句柄产出的一个样本。同一时刻只有一个值字段有意义，
// 由通道 new 时固定的 Type 决定。
type Result struct {
	Type   ValueType
	I16    int16
	I32    int32
	F64    uint64
	Time   Timestamp
	Source Source
}
