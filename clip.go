// Package dataeng 提供按参考坐标半开区间裁剪 CIGAR 比对记录的能力。
//
// 本包只处理给定方向的记录，不做反向互补，也不读取或写出 SAM 文件。
// 所有坐标、长度均使用 uint64，端点求和一律走溢出检查。
package dataeng

import (
	"errors"
	"math"
)

// Op 是规范化的 CIGAR 操作类型。
type Op uint8

// 支持的 CIGAR 操作。
const (
	OpM         Op = iota // M：同时消费参考与读段
	OpEqual               // =：同时消费参考与读段
	OpDiff                // X：同时消费参考与读段
	OpInsertion           // I：只消费读段
	OpDeletion            // D：只消费参考
	OpRefSkip             // N：只消费参考
	OpSoftClip            // S：只消费读段，仅可位于去掉 H 后的两端
	OpHardClip            // H：不消费参考与读段，仅可位于最外端
)

// Valid 判断操作类型是否已知。
func (o Op) Valid() bool { return o <= OpHardClip }

// ConsumesRead 报告该操作是否消费读段碱基。
func (o Op) ConsumesRead() bool {
	switch o {
	case OpM, OpEqual, OpDiff, OpInsertion, OpSoftClip:
		return true
	default:
		return false
	}
}

// ConsumesRef 报告该操作是否消费参考坐标。
func (o Op) ConsumesRef() bool {
	switch o {
	case OpM, OpEqual, OpDiff, OpDeletion, OpRefSkip:
		return true
	default:
		return false
	}
}

// Byte 返回该操作对应的 CIGAR 字符。
func (o Op) Byte() byte {
	switch o {
	case OpM:
		return 'M'
	case OpEqual:
		return '='
	case OpDiff:
		return 'X'
	case OpInsertion:
		return 'I'
	case OpDeletion:
		return 'D'
	case OpRefSkip:
		return 'N'
	case OpSoftClip:
		return 'S'
	case OpHardClip:
		return 'H'
	default:
		return '?'
	}
}

// String 返回该操作对应的单字符 CIGAR 名称。
func (o Op) String() string { return string(o.Byte()) }

// Operation 是一条带正长度的 CIGAR 操作。
type Operation struct {
	Kind   Op
	Length uint64
}

// Record 是一条待裁剪的原始比对记录。
type Record struct {
	// RefStart 是参考起点 s（含）。
	RefStart uint64
	// CIGAR 是非空、长度均为正的操作序列。
	CIGAR []Operation
	// Bases 是原始读段碱基，顺序与给定方向一致，不做反向互补。
	Bases []byte
	// Qualities 与 Bases 等长。
	Qualities []byte
}

// 校验与裁剪过程中可能返回的哨兵错误。
var (
	ErrNilRecord          = errors.New("dataeng: record 为 nil")
	ErrEmptyCIGAR         = errors.New("dataeng: CIGAR 操作序列为空")
	ErrUnknownOp          = errors.New("dataeng: 未知 CIGAR 操作")
	ErrZeroLength         = errors.New("dataeng: CIGAR 操作长度必须为正")
	ErrAdjacentSameOp     = errors.New("dataeng: 禁止相邻同操作")
	ErrHardClipPosition   = errors.New("dataeng: H 仅可位于操作序列最外端")
	ErrSoftClipPosition   = errors.New("dataeng: S 仅可位于去掉 H 后的两端")
	ErrReadLengthMismatch = errors.New("dataeng: 已消费读段长度与 Bases 长度不一致")
	ErrQualityLenMismatch = errors.New("dataeng: Qualities 长度必须与 Bases 一致")
	ErrWindowReversed     = errors.New("dataeng: 裁剪窗口要求 L <= R")
	ErrOverflow           = errors.New("dataeng: 整数求和溢出 uint64")
	ErrEmptyClip          = errors.New("dataeng: 裁剪结果为空")
	ErrIndexOutOfRange    = errors.New("dataeng: 下标超出新记录范围")
	ErrCoordOutOfRange    = errors.New("dataeng: 参考坐标超出新记录范围")
)

// OpError 携带出错操作在原始 CIGAR 中的下标（0 起）。
// 与具体操作无关的错误使用 -1。
type OpError struct {
	OpIndex int
	Err     error
}

// Error 实现 error。
func (e *OpError) Error() string {
	if e.OpIndex < 0 {
		return e.Err.Error()
	}
	return e.Err.Error() + "（操作下标 " + uitoa(uint64(e.OpIndex)) + "）"
}

// Unwrap 支持 errors.Is/As。
func (e *OpError) Unwrap() error { return e.Err }

func opErr(i int, err error) error { return &OpError{OpIndex: i, Err: err} }

// add64 计算 a+b，结果不可表示时 ok=false。
func add64(a, b uint64) (sum uint64, ok bool) {
	if b > math.MaxUint64-a {
		return 0, false
	}
	return a + b, true
}

func maxU64(a, b uint64) uint64 {
	if a > b {
		return a
	}
	return b
}

func minU64(a, b uint64) uint64 {
	if a < b {
		return a
	}
	return b
}

// intersect 返回 [aLo,aHi) 与 [L,R) 的交集半开区间与长度。
func intersect(aLo, aHi, L, R uint64) (lo, hi, length uint64) {
	lo = maxU64(aLo, L)
	hi = minU64(aHi, R)
	if hi <= lo {
		return 0, 0, 0
	}
	return lo, hi, hi - lo
}

func uitoa(x uint64) string {
	if x == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for x > 0 {
		i--
		buf[i] = byte('0' + x%10)
		x /= 10
	}
	return string(buf[i:])
}
