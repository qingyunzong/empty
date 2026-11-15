package dataeng

import (
	"math"
	"sort"
)

// Value 对应 MVT Value 消息。指针字段用于区分 proto2 的显式零值与未设置：
// 例如 int64(0) 与 bool(false) 必须能进入字典，而 nil 表示该字段不存在。
// 一个合法 Value 有且仅有一个非 nil 字段。
type Value struct {
	StringValue *string
	FloatValue  *float32
	DoubleValue *float64
	IntValue    *int64
	UintValue   *uint64
	SintValue   *int64
	BoolValue   *bool
}

// 值类型在 MVT Value 消息中的 proto 字段号，同时作为类型排序秩。
// 类型不同的值即使文本表示相同也必须视作不同字典项。
const (
	valueRankString uint8 = 1
	valueRankFloat  uint8 = 2
	valueRankDouble uint8 = 3
	valueRankInt    uint8 = 4
	valueRankUint   uint8 = 5
	valueRankSint   uint8 = 6
	valueRankBool   uint8 = 7
)

// NewStringValue 构造字符串型字典值。
func NewStringValue(v string) Value { return Value{StringValue: &v} }

// NewFloatValue 构造 float 型（proto fixed32）字典值。
func NewFloatValue(v float32) Value { return Value{FloatValue: &v} }

// NewDoubleValue 构造 double 型（proto fixed64）字典值。
func NewDoubleValue(v float64) Value { return Value{DoubleValue: &v} }

// NewIntValue 构造 int64 型字典值。
func NewIntValue(v int64) Value { return Value{IntValue: &v} }

// NewUintValue 构造 uint64 型字典值。
func NewUintValue(v uint64) Value { return Value{UintValue: &v} }

// NewSintValue 构造 sint64（zigzag 编码）型字典值。
func NewSintValue(v int64) Value { return Value{SintValue: &v} }

// NewBoolValue 构造 bool 型字典值。
func NewBoolValue(v bool) Value { return Value{BoolValue: &v} }

// valueRank 返回值的类型秩；0 表示非法 Value。
func (v Value) valueRank() uint8 {
	switch {
	case v.StringValue != nil:
		return valueRankString
	case v.FloatValue != nil:
		return valueRankFloat
	case v.DoubleValue != nil:
		return valueRankDouble
	case v.IntValue != nil:
		return valueRankInt
	case v.UintValue != nil:
		return valueRankUint
	case v.SintValue != nil:
		return valueRankSint
	case v.BoolValue != nil:
		return valueRankBool
	default:
		return 0
	}
}

// Valid 判断 Value 是否恰好设置了一个字段。
func (v Value) Valid() bool {
	set := 0
	if v.StringValue != nil {
		set++
	}
	if v.FloatValue != nil {
		set++
	}
	if v.DoubleValue != nil {
		set++
	}
	if v.IntValue != nil {
		set++
	}
	if v.UintValue != nil {
		set++
	}
	if v.SintValue != nil {
		set++
	}
	if v.BoolValue != nil {
		set++
	}
	return set == 1
}

// valueKey 是字典去重的内部标识：类型秩 + 规范化后的载荷。
// 不同类型（如文本 "1"、int 1、uint 1、sint 1、bool true、float 1.0、
// double 1.0）天然得到不同的 key，杜绝按文本合并。
type valueKey struct {
	rank uint8
	text string
	bits uint64
}

func (v Value) key() valueKey {
	switch r := v.valueRank(); r {
	case valueRankString:
		return valueKey{rank: r, text: *v.StringValue}
	case valueRankFloat:
		return valueKey{rank: r, bits: uint64(math.Float32bits(*v.FloatValue))}
	case valueRankDouble:
		return valueKey{rank: r, bits: math.Float64bits(*v.DoubleValue)}
	case valueRankInt:
		return valueKey{rank: r, bits: uint64(*v.IntValue)}
	case valueRankUint:
		return valueKey{rank: r, bits: *v.UintValue}
	case valueRankSint:
		return valueKey{rank: r, bits: uint64(*v.SintValue)}
	case valueRankBool:
		if *v.BoolValue {
			return valueKey{rank: r, bits: 1}
		}
		return valueKey{rank: r, bits: 0}
	default:
		return valueKey{}
	}
}

// compareValue 给出全序比较：先按类型秩，再按同类型载荷比较，
// 供输出字典稳定排序使用。返回 -1/0/1。
func compareValue(a, b Value) int {
	ra, rb := a.valueRank(), b.valueRank()
	if ra != rb {
		if ra < rb {
			return -1
		}
		return 1
	}
	switch ra {
	case valueRankString:
		return compareStrings(*a.StringValue, *b.StringValue)
	case valueRankFloat:
		return compareFloatBits(uint64(math.Float32bits(*a.FloatValue)), uint64(math.Float32bits(*b.FloatValue)), true)
	case valueRankDouble:
		return compareFloatBits(math.Float64bits(*a.DoubleValue), math.Float64bits(*b.DoubleValue), false)
	case valueRankInt, valueRankSint:
		var av, bv uint64
		if ra == valueRankSint {
			av, bv = uint64(*a.SintValue), uint64(*b.SintValue)
		} else {
			av, bv = uint64(*a.IntValue), uint64(*b.IntValue)
		}
		return compareSigned(av, bv)
	case valueRankUint, valueRankBool:
		av, bv := a.key().bits, b.key().bits
		if av < bv {
			return -1
		}
		if av > bv {
			return 1
		}
		return 0
	default:
		return 0
	}
}

func compareStrings(a, b string) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

// compareSigned 把补码位模式还原为有符号序比较。
func compareSigned(a, b uint64) int {
	sa := int64(a)
	sb := int64(b)
	if sa < sb {
		return -1
	}
	if sa > sb {
		return 1
	}
	return 0
}

// compareFloatBits 实现 IEEE-754 位模式的全序，保证 NaN 也有确定位置。
func compareFloatBits(a, b uint64, bits32 bool) int {
	mask := uint64(1<<64 - 1)
	signBit := uint64(1) << 63
	if bits32 {
		mask = 1<<32 - 1
		signBit = 1 << 31
	}
	// 负数整体翻转，正数只翻符号位，映射后按无符号序比较。
	if a&signBit != 0 {
		a = ^a & mask
	} else {
		a ^= signBit
	}
	if b&signBit != 0 {
		b = ^b & mask
	} else {
		b ^= signBit
	}
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

// sortValues 按全序稳定排序 Value 切片。
func sortValues(values []Value) {
	sort.SliceStable(values, func(i, j int) bool {
		return compareValue(values[i], values[j]) < 0
	})
}
