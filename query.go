package dataeng

import (
	"errors"
	"sort"
)

// errNonContiguous 是仅在内部不变量被破坏时返回的防御性错误。
var errNonContiguous = errors.New("dataeng: 内部错误：保留读段不连续")

// buildSegs 用规范化 CIGAR 重建新记录的逐段坐标投影。
func buildSegs(cigar []Operation, refStart uint64) []seg {
	segs := make([]seg, 0, len(cigar))
	var refPos, readPos uint64
	refPos = refStart
	for _, op := range cigar {
		s := seg{kind: op.Kind, refStart: refPos, readStart: readPos}
		switch op.Kind {
		case OpInsertion:
			next, ok := add64(readPos, op.Length)
			if !ok {
				panic(ErrOverflow)
			}
			readPos = next
		case OpDeletion, OpRefSkip:
			next, ok := add64(refPos, op.Length)
			if !ok {
				panic(ErrOverflow)
			}
			refPos = next
		default: // M / = / X
			rNext, ok := add64(refPos, op.Length)
			if !ok {
				panic(ErrOverflow)
			}
			dNext, ok := add64(readPos, op.Length)
			if !ok {
				panic(ErrOverflow)
			}
			refPos, readPos = rNext, dNext
		}
		s.refEnd = refPos
		s.readEnd = readPos
		segs = append(segs, s)
	}
	return segs
}

// QueryKind 区分双向查询命中的类别。
type QueryKind uint8

const (
	// KindAligned：双消费操作内的正常比对位置。
	KindAligned QueryKind = iota
	// KindInsertion：读段下标落在 I 内，坐标为插入锚点。
	KindInsertion
	// KindDeletion：参考坐标落在 D 缺口内。
	KindDeletion
	// KindRefSkip：参考坐标落在 N 缺跨内。
	KindRefSkip
)

// ReadPosition 是“新记录读段下标 -> 参考坐标/插入锚点”的结果。
type ReadPosition struct {
	Kind      QueryKind
	RefCoord  uint64 // KindAligned 为对应参考坐标；KindInsertion 为锚点
	ReadIndex uint64 // 回显的新记录本地读段下标
}

// RefPosition 是“参考坐标 -> 读段下标/D/N 缺口”的结果。
type RefPosition struct {
	Kind      QueryKind
	ReadIndex uint64 // 命中碱基的新记录本地读段下标；缺口时为缺口前最后一个消费读段的下标
	GapStart  uint64 // 仅缺口时有效：缺口在参考上的半开起点
	GapEnd    uint64 // 仅缺口时有效：缺口在参考上的半开终点
	HasPrev   bool   // 缺口前是否存在已消费读段（否则 ReadIndex 无意义）
}

func (c *Clipped) requireNonEmpty() error {
	if c == nil || c.Empty {
		return ErrEmptyClip
	}
	return nil
}

// MapRead 把新记录中的本地读段下标映射到参考坐标或插入锚点。
//
// idx 的有效范围是 [0, ReadLength())；I 内的下标返回 KindInsertion
// 与锚点坐标，M/=/X 内的下标返回 KindAligned。
func (c *Clipped) MapRead(idx uint64) (ReadPosition, error) {
	if err := c.requireNonEmpty(); err != nil {
		return ReadPosition{}, err
	}
	readLen := c.ReadLength()
	if idx >= readLen {
		return ReadPosition{}, ErrIndexOutOfRange
	}
	k := sort.Search(len(c.segs), func(k int) bool {
		return c.segs[k].readEnd > idx
	})
	s := c.segs[k]
	if s.kind == OpInsertion {
		return ReadPosition{Kind: KindInsertion, RefCoord: s.refStart, ReadIndex: idx}, nil
	}
	// 能被读段下标命中的非 I 段一定是 M/=/X。
	return ReadPosition{
		Kind:      KindAligned,
		RefCoord:  s.refStart + (idx - s.readStart),
		ReadIndex: idx,
	}, nil
}

// MapRef 把参考坐标映射到新记录中的读段下标或 D/N 缺口。
//
// 有效坐标范围是 [RefStart, RefStart+RefLength())。坐标落在 M/=/X 内时
// 返回 KindAligned；落在 D/N 内时返回对应缺口类别及缺口区间，并区分
// D（KindDeletion）与 N（KindRefSkip）。
func (c *Clipped) MapRef(coord uint64) (RefPosition, error) {
	if err := c.requireNonEmpty(); err != nil {
		return RefPosition{}, err
	}
	// 半开末端 RefStart+RefLength 可能等于 MaxUint64+1 而不可表示，
	// 因此用差值比较而不是对末端点求和。
	if coord < c.RefStart || coord-c.RefStart >= c.RefLength() {
		return RefPosition{}, ErrCoordOutOfRange
	}
	k := sort.Search(len(c.segs), func(k int) bool {
		return c.segs[k].refEnd > coord
	})
	s := c.segs[k]
	switch s.kind {
	case OpDeletion, OpRefSkip:
		kind := KindDeletion
		if s.kind == OpRefSkip {
			kind = KindRefSkip
		}
		pos := RefPosition{
			Kind:     kind,
			GapStart: s.refStart,
			GapEnd:   s.refEnd,
		}
		if s.readStart > 0 {
			pos.HasPrev = true
			pos.ReadIndex = s.readStart - 1
		}
		return pos, nil
	default: // M / = / X（I 的 refStart==refEnd，不可能容纳半开坐标）
		return RefPosition{
			Kind:      KindAligned,
			ReadIndex: s.readStart + (coord - s.refStart),
		}, nil
	}
}
