package dataeng

import "fmt"

var cigarOpByByte = map[byte]Op{
	'M': OpM,
	'=': OpEqual,
	'X': OpDiff,
	'I': OpInsertion,
	'D': OpDeletion,
	'N': OpRefSkip,
	'S': OpSoftClip,
	'H': OpHardClip,
}

// ParseCIGAR 解析形如 5H3M2D4M2S 的 CIGAR 字符串。
//
// 仅做词法解析；结构合法性（S/H 位置、相邻同操作、读长等）由 Clip 校验。
func ParseCIGAR(s string) ([]Operation, error) {
	if len(s) == 0 {
		return nil, opErr(-1, ErrEmptyCIGAR)
	}
	var ops []Operation
	var num uint64
	haveDigit := false
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch >= '0' && ch <= '9' {
			d := uint64(ch - '0')
			if haveDigit {
				if num > (maxUint64Value-d)/10 {
					return nil, opErr(len(ops), ErrOverflow)
				}
				num = num*10 + d
			} else {
				num = d
				haveDigit = true
			}
			continue
		}
		kind, ok := cigarOpByByte[ch]
		if !ok || !haveDigit {
			return nil, fmt.Errorf("dataeng: 非法 CIGAR 字符 %q", ch)
		}
		if num == 0 {
			return nil, opErr(len(ops), ErrZeroLength)
		}
		ops = append(ops, Operation{Kind: kind, Length: num})
		num, haveDigit = 0, false
	}
	if haveDigit {
		return nil, fmt.Errorf("dataeng: CIGAR 末尾缺少操作字符")
	}
	if len(ops) == 0 {
		return nil, opErr(-1, ErrEmptyCIGAR)
	}
	return ops, nil
}

// maxUint64Value 与 math.MaxUint64 保持一致，局部定义避免额外导入。
const maxUint64Value = ^uint64(0)
