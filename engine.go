package dataeng

import (
	"io"
	"sync"
)

// indexEntry 是某路径最近一次成功 new 的完整索引。
// 类型与端序在首次 new 时固定，后续 new 只允许改 SamplesPerChunk。
type indexEntry struct {
	typeName        ValueType
	endian          Endian
	samplesPerChunk int64
}

// channelInSegment 是段内活动通道的解析结果与字节定位信息。
type channelInSegment struct {
	path            string
	typeName        ValueType
	endian          Endian
	samplesPerChunk int64
	width           int
	// offsetInChunk 是该通道第一个样本相对段原始区起点的块内字节偏移。
	offsetInChunk int64
	// sampleStride 是同一通道相邻样本在一个 chunk 内的字节步长：
	// contiguous 为类型宽度，interleaved 为 chunk 内所有通道宽度之和。
	sampleStride int64
}

// segmentRecord 是已提交段的不可变记录。读取句柄只依赖这些记录，
// 索引按 chunk 保存（samplesPerChunk/chunkBytes 等），不为每个样本建项。
type segmentRecord struct {
	segmentNumber int64
	endian        Endian
	layout        RawLayout
	reader        io.ReaderAt
	rawOffset     int64
	rawLength     int64
	chunkBytes    int64
	chunks        int64
	active        []*channelInSegment
	channelByPath map[string]*channelInSegment
	// firstLogical 是本段开始前各路径已经累积的逻辑样本数快照。
	firstLogical map[string]int64
	// count 是本段各路径实际提交的样本数（chunks*n）。
	count map[string]int64
}

// Engine 是线程安全的原始通道读取引擎，维护跨段索引缓存、活动顺序与样本计数。
// 零值不可用，必须通过 New 构造。
type Engine struct {
	mu sync.RWMutex

	budget Budget

	lastSegment int64

	// indexes 是按路径的最近一次 new 索引缓存，none 不会删除条目。
	indexes map[string]indexEntry
	// activeOrder 是最近一个已提交段的活动路径顺序。
	activeOrder []string

	// totalSamples 是每路径跨段累积的稳定逻辑样本数。
	totalSamples map[string]int64
	// segments 按 SegmentNumber 严格递增保存已提交段。
	segments []*segmentRecord
	// pathSegments 保存每路径出现过（有原始数据）的段在 segments 中的下标。
	pathSegments map[string][]int
}

// New 构造引擎并校验预算。预算是硬性上限，后续所有提交与寻址都受其约束。
func New(budget Budget) (*Engine, error) {
	if budget.MaxChannelsPerSegment <= 0 {
		return nil, wrapf(ErrInvalidArgument, "MaxChannelsPerSegment must be positive, got %d", budget.MaxChannelsPerSegment)
	}
	if budget.MaxChunksPerSegment <= 0 {
		return nil, wrapf(ErrInvalidArgument, "MaxChunksPerSegment must be positive, got %d", budget.MaxChunksPerSegment)
	}
	if budget.MaxCachedIndexes <= 0 {
		return nil, wrapf(ErrInvalidArgument, "MaxCachedIndexes must be positive, got %d", budget.MaxCachedIndexes)
	}
	return &Engine{
		budget:       budget,
		indexes:      make(map[string]indexEntry),
		totalSamples: make(map[string]int64),
		pathSegments: make(map[string][]int),
	}, nil
}

func validateSegmentHeader(seg Segment) error {
	if seg.SegmentNumber <= 0 {
		return wrapf(ErrInvalidArgument, "segment number must be positive, got %d", seg.SegmentNumber)
	}
	if seg.Endian != LittleEndian && seg.Endian != BigEndian {
		return wrapf(ErrInvalidArgument, "segment %d has unknown endian %d", seg.SegmentNumber, seg.Endian)
	}
	if !seg.Layout.valid() {
		return wrapf(ErrInvalidArgument, "segment %d has unknown raw layout %d", seg.SegmentNumber, seg.Layout)
	}
	if seg.RawLength < 0 || seg.RawOffset < 0 {
		return wrapf(ErrInvalidArgument, "segment %d raw offset/length must be non-negative", seg.SegmentNumber)
	}
	if seg.RawLength > 0 && seg.Reader == nil {
		return wrapf(ErrInvalidArgument, "segment %d has raw bytes but no ReaderAt", seg.SegmentNumber)
	}
	return nil
}

func buildNewIndex(seg Segment, u Update) (indexEntry, error) {
	if !u.Type.valid() {
		return indexEntry{}, wrapf(ErrInvalidArgument, "segment %d new index for %q has unknown type %d", seg.SegmentNumber, u.Path, u.Type)
	}
	if u.SamplesPerChunk <= 0 {
		return indexEntry{}, wrapf(ErrInvalidArgument, "segment %d new index for %q requires positive n, got %d", seg.SegmentNumber, u.Path, u.SamplesPerChunk)
	}
	return indexEntry{
		typeName:        u.Type,
		endian:          seg.Endian,
		samplesPerChunk: u.SamplesPerChunk,
	}, nil
}

// checkTypeAndEndian 保证首次 new 固定类型与端序，后续 new 只能改 n。
// 解析同时看本次暂存索引与已提交缓存，且绝不会借用其他路径的索引。
func checkTypeAndEndian(seg Segment, path string, next indexEntry, resolve func(string) (indexEntry, bool)) error {
	prev, ok := resolve(path)
	if !ok {
		return nil
	}
	if prev.typeName != next.typeName {
		return wrapf(ErrTypeConflict, "segment %d changes type of %q from %d to %d", seg.SegmentNumber, path, prev.typeName, next.typeName)
	}
	if prev.endian != next.endian {
		return wrapf(ErrTypeConflict, "segment %d changes endian of %q", seg.SegmentNumber, path)
	}
	return nil
}

// computeChunkBytes 返回单 chunk 字节数；交错布局额外返回通道宽度之和作为样本步长。
func computeChunkBytes(layout RawLayout, active []*channelInSegment) (chunkBytes int64, interleaveStride int64, err error) {
	switch layout {
	case LayoutContiguous:
		var total int64
		for _, ch := range active {
			channelBytes, mErr := mul64(ch.samplesPerChunk, int64(ch.width))
			if mErr != nil {
				return 0, 0, wrapf(mErr, "channel %q chunk bytes", ch.path)
			}
			total, mErr = add64(total, channelBytes)
			if mErr != nil {
				return 0, 0, wrapf(mErr, "channel %q chunk offset", ch.path)
			}
		}
		return total, 0, nil
	case LayoutInterleaved:
		var stride int64
		for _, ch := range active {
			next, aErr := add64(stride, int64(ch.width))
			if aErr != nil {
				return 0, 0, wrapf(aErr, "interleaved stride overflow at %q", ch.path)
			}
			stride = next
		}
		n := active[0].samplesPerChunk
		total, mErr := mul64(stride, n)
		if mErr != nil {
			return 0, 0, wrapf(mErr, "interleaved chunk bytes")
		}
		return total, stride, nil
	default:
		return 0, 0, wrapf(ErrInvalidArgument, "unknown raw layout %d", layout)
	}
}
