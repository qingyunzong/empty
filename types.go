package dataeng

import "errors"

const (
	// BlockSize 是物理块大小（32KiB）。
	BlockSize = 32768
	// HeaderSize 是每个片的固定头长：掩码 CRC(4) + 载荷长(2) + 类型(1)。
	HeaderSize = 7
)

// FragmentType 是片类型字段的取值。
type FragmentType uint8

const (
	// Zero 不是记录片：完整零头表示块剩余部分为零填充。
	Zero   FragmentType = 0
	Full   FragmentType = 1
	First  FragmentType = 2
	Middle FragmentType = 3
	Last   FragmentType = 4
)

// String 返回片类型的规范名称，便于诊断输出。
func (t FragmentType) String() string {
	switch t {
	case Zero:
		return "ZERO"
	case Full:
		return "FULL"
	case First:
		return "FIRST"
	case Middle:
		return "MIDDLE"
	case Last:
		return "LAST"
	default:
		return "UNKNOWN"
	}
}

// Mode 选择 EOF 残尾的处理策略。
type Mode int

const (
	// Strict 在 EOF 遇到残头、残载荷或未闭合记录时返回损坏错误。
	Strict Mode = iota
	// Recovery 仅允许丢弃真实 EOF 处未完成的尾记录，并记录截断报告。
	Recovery
)

// ErrorKind 对损坏与中止原因进行稳定分类，便于宿主区分处理。
type ErrorKind int

const (
	ErrUnspecified ErrorKind = iota
	ErrCRC
	ErrIllegalType
	ErrBlockOverrun
	ErrBadPadding
	ErrSequence
	ErrRecordTooLarge
	ErrTotalLimit
	ErrTruncatedHeader
	ErrTruncatedPayload
	ErrUnclosedRecord
	ErrCallback
	ErrCheckpoint
	ErrTerminated
	ErrInvalidOption
)

func (k ErrorKind) String() string {
	switch k {
	case ErrCRC:
		return "crc mismatch"
	case ErrIllegalType:
		return "illegal fragment type"
	case ErrBlockOverrun:
		return "fragment crosses block boundary"
	case ErrBadPadding:
		return "non-zero padding"
	case ErrSequence:
		return "fragment sequence error"
	case ErrRecordTooLarge:
		return "logical record exceeds size limit"
	case ErrTotalLimit:
		return "total delivered bytes exceed limit"
	case ErrTruncatedHeader:
		return "truncated fragment header at EOF"
	case ErrTruncatedPayload:
		return "truncated payload at EOF"
	case ErrUnclosedRecord:
		return "unclosed logical record at EOF"
	case ErrCallback:
		return "callback failed"
	case ErrCheckpoint:
		return "invalid checkpoint"
	case ErrTerminated:
		return "reader already terminated"
	case ErrInvalidOption:
		return "invalid option"
	default:
		return "log corruption"
	}
}

// Error 携带稳定分类与首个相关物理偏移。
type Error struct {
	Kind   ErrorKind
	Offset int64
	Err    error
}

func (e *Error) Error() string {
	if e.Err != nil {
		return "dataeng: " + e.Kind.String() + " at offset " + itoa(e.Offset) + ": " + e.Err.Error()
	}
	return "dataeng: " + e.Kind.String() + " at offset " + itoa(e.Offset)
}

func (e *Error) Unwrap() error { return e.Err }

// 哨兵错误：宿主可用 errors.Is 判断类别；回调自身错误经 ErrCallback 包装后仍可 Unwrap。
var (
	errCRC              = errors.New("masked crc mismatch")
	errIllegalType      = errors.New("fragment type is not 0..4")
	errBlockOverrun     = errors.New("header+length would cross the physical block")
	errBadPadding       = errors.New("padding region contains a non-zero byte")
	errSequence         = errors.New("fragment type does not continue the current sequence")
	errRecordTooLarge   = errors.New("logical record exceeds MaxRecordSize")
	errTotalLimit       = errors.New("total delivered bytes exceed MaxTotalBytes")
	errTruncatedHeader  = errors.New("incomplete fragment header at EOF")
	errTruncatedPayload = errors.New("incomplete payload at EOF")
	errUnclosedRecord   = errors.New("logical record is not closed at EOF")
	errCheckpoint       = errors.New("checkpoint does not bind a confirmed logical-record boundary")
	errTerminated       = errors.New("reader has already terminated")
	errInvalidOption    = errors.New("invalid reader option")
)

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	var buf [20]byte
	i := len(buf)
	for n != 0 {
		d := n % 10
		if d < 0 {
			d = -d
		}
		i--
		buf[i] = byte('0' + d)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
