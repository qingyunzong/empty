package dataeng

import (
	"errors"
	"fmt"
	"math"
)

// 以下哨兵错误让宿主能用 errors.Is 区分拒绝原因；具体上下文通过 %w 包裹保留。
var (
	// ErrInvalidArgument 表示段输入、预算或读取区间本身不合法。
	ErrInvalidArgument = errors.New("dataeng: invalid argument")
	// ErrDuplicateSegment 表示段号已提交或不满足严格递增。
	ErrDuplicateSegment = errors.New("dataeng: segment number already committed or out of order")
	// ErrDuplicatePath 表示同一段更新列表中同一路径出现多次。
	ErrDuplicatePath = errors.New("dataeng: duplicate channel path in segment")
	// ErrReuseWithoutIndex 表示 reuse 时该路径从未在已提交缓存中 new 过。
	ErrReuseWithoutIndex = errors.New("dataeng: reuse without prior new index")
	// ErrTypeConflict 表示后续 new 试图改变路径首次固定的类型或端序。
	ErrTypeConflict = errors.New("dataeng: channel type or endian conflict")
	// ErrBudgetExceeded 表示通道数、chunk 数或索引缓存超出预算。
	ErrBudgetExceeded = errors.New("dataeng: budget exceeded")
	// ErrRawLayout 表示原始区长度与声明布局不匹配（短尾、交错 n 不一致等）。
	ErrRawLayout = errors.New("dataeng: invalid raw layout")
	// ErrAddressOverflow 表示寻址乘法或加法在读取前溢出 int64。
	ErrAddressOverflow = errors.New("dataeng: addressing overflow")
	// ErrUnknownPath 表示读取了引擎从未见过的路径。
	ErrUnknownPath = errors.New("dataeng: unknown channel path")
	// ErrRange 表示逻辑半开区间非法或超出该路径已提交样本数。
	ErrRange = errors.New("dataeng: logical sample range out of bounds")
	// ErrReadFailed 表示底层不可变 ReaderAt 读取失败或返回不足字节。
	ErrReadFailed = errors.New("dataeng: raw byte read failed")
)

func wrapf(base error, format string, args ...any) error {
	return fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), base)
}

// mul64 计算 a*b，结果或中间转换溢出 int64 时返回 ErrAddressOverflow。
// 入参均为非负有限值。
func mul64(a, b int64) (int64, error) {
	if a == 0 || b == 0 {
		return 0, nil
	}
	if a < 0 || b < 0 {
		return 0, ErrAddressOverflow
	}
	if a > math.MaxInt64/b {
		return 0, ErrAddressOverflow
	}
	return a * b, nil
}

// add64 计算 a+b，溢出 int64 时返回 ErrAddressOverflow。
func add64(a, b int64) (int64, error) {
	if (b > 0 && a > math.MaxInt64-b) || (b < 0 && a < math.MinInt64-b) {
		return 0, ErrAddressOverflow
	}
	return a + b, nil
}
