package auditlog

import "fmt"

// MaskByte 为脱敏替换字节。范围内每个字节都被替换为该值，
// 保证脱敏后载荷长度与原载荷一致，范围外字节逐字节不变。
const MaskByte = 0x2A // '*'

// Redact 返回 payload 的脱敏副本与规范化后的范围清单。
// 原 payload 不被修改；范围外字节与原载荷完全一致。
// 范围非法（越界、负值、Start > End）时返回错误。
func Redact(payload []byte, ranges []Range) ([]byte, []Range, error) {
	merged, err := ValidateRanges(ranges, len(payload))
	if err != nil {
		return nil, nil, err
	}
	out := make([]byte, len(payload))
	copy(out, payload)
	for _, r := range merged {
		for i := r.Start; i < r.End; i++ {
			out[i] = MaskByte
		}
	}
	return out, merged, nil
}

// Redactor 支持载荷分块到达、范围跨块声明的增量脱敏。
// 各块通过 AddChunk 追加，范围使用相对整个载荷的绝对偏移，
// 因此一个范围可以横跨多个块的边界；Finalize 时统一校验并合并。
type Redactor struct {
	buf    []byte
	ranges []Range
}

// AddChunk 追加一块载荷数据，以及（可选的）针对整个载荷的绝对偏移范围。
// 范围可以引用尚未到达的后续块，合法性在 Finalize 时统一校验。
func (r *Redactor) AddChunk(chunk []byte, ranges ...Range) {
	r.buf = append(r.buf, chunk...)
	r.ranges = append(r.ranges, ranges...)
}

// Finalize 校验并合并跨块范围，产出脱敏载荷与规范范围清单。
// 任一范围非法（含超出最终载荷总长度）即返回错误。
func (r *Redactor) Finalize() ([]byte, []Range, error) {
	redacted, merged, err := Redact(r.buf, r.ranges)
	if err != nil {
		return nil, nil, fmt.Errorf("finalize: %w", err)
	}
	return redacted, merged, nil
}
