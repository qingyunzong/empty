package auditlog

import (
	"bytes"
	"errors"
	"testing"
)

// 脱敏后范围外字节必须与原载荷逐字节一致，范围内字节全部为掩码。
func TestRedactPreservesBytesOutsideRanges(t *testing.T) {
	payload := []byte("user=alice; password=s3cr3t-token; role=admin")
	ranges := []Range{{Start: 24, End: 37}} // 覆盖 "s3cr3t-token"
	out, merged, err := Redact(payload, ranges)
	if err != nil {
		t.Fatalf("Redact: %v", err)
	}
	if len(out) != len(payload) {
		t.Fatalf("length changed: got %d want %d", len(out), len(payload))
	}
	for _, r := range merged {
		for i := 0; i < len(payload); i++ {
			inRange := i >= r.Start && i < r.End
			if inRange && out[i] != MaskByte {
				t.Fatalf("byte %d inside range not masked: %q", i, out[i])
			}
			if !inRange && out[i] != payload[i] {
				t.Fatalf("byte %d outside range changed: %q -> %q", i, payload[i], out[i])
			}
		}
	}
	if bytes.Contains(out, []byte("s3cr3t-token")) {
		t.Fatal("secret still present in redacted payload")
	}
}

// 脱敏不得修改调用方的原载荷。
func TestRedactDoesNotMutateInput(t *testing.T) {
	payload := []byte("abcdef-secret-ghij")
	orig := append([]byte(nil), payload...)
	if _, _, err := Redact(payload, []Range{{Start: 7, End: 13}}); err != nil {
		t.Fatalf("Redact: %v", err)
	}
	if !bytes.Equal(payload, orig) {
		t.Fatal("input payload was mutated")
	}
}

// 跨块到达的载荷与跨块声明的范围必须正确合并脱敏。
func TestCrossChunkRangeMerging(t *testing.T) {
	var r Redactor
	// 载荷分三块到达，秘密横跨块 1 与块 2 的边界。
	r.AddChunk([]byte("token="), Range{Start: 6, End: 10})    // 引用尚未到达的块 2
	r.AddChunk([]byte("abcd"), Range{Start: 8, End: 14})      // 与上一范围跨块重叠
	r.AddChunk([]byte("XYZ-tail"), Range{Start: 15, End: 18}) // 块 3 内独立范围
	redacted, merged, err := r.Finalize()
	if err != nil {
		t.Fatalf("Finalize: %v", err)
	}
	want := []Range{{Start: 6, End: 14}, {Start: 15, End: 18}}
	if len(merged) != len(want) {
		t.Fatalf("merged ranges = %v, want %v", merged, want)
	}
	for i := range want {
		if merged[i] != want[i] {
			t.Fatalf("merged[%d] = %v, want %v", i, merged[i], want[i])
		}
	}
	full := []byte("token=abcdXYZ-tail")
	for i := range full {
		inRange := (i >= 6 && i < 14) || (i >= 15 && i < 18)
		if inRange && redacted[i] != MaskByte {
			t.Fatalf("byte %d not masked", i)
		}
		if !inRange && redacted[i] != full[i] {
			t.Fatalf("byte %d outside range changed", i)
		}
	}
}

// 相邻（首尾相接）范围也应合并为一个范围。
func TestAdjacentRangesMerge(t *testing.T) {
	_, merged, err := Redact([]byte("0123456789"), []Range{{2, 4}, {4, 7}, {8, 9}})
	if err != nil {
		t.Fatalf("Redact: %v", err)
	}
	want := []Range{{2, 7}, {8, 9}}
	if len(merged) != len(want) || merged[0] != want[0] || merged[1] != want[1] {
		t.Fatalf("merged = %v, want %v", merged, want)
	}
}

// 非法范围必须被拒绝：负值、Start > End、超出载荷长度。
func TestInvalidRangesRejected(t *testing.T) {
	payload := []byte("0123456789")
	cases := []struct {
		name string
		r    Range
	}{
		{"negative start", Range{-1, 3}},
		{"negative end", Range{1, -3}},
		{"start after end", Range{7, 3}},
		{"end beyond length", Range{0, 11}},
		{"start beyond length", Range{11, 11}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := Redact(payload, []Range{tc.r}); !errors.Is(err, ErrInvalidRange) {
				t.Fatalf("Redact(%v) err = %v, want ErrInvalidRange", tc.r, err)
			}
			var r Redactor
			r.AddChunk(payload, tc.r)
			if _, _, err := r.Finalize(); !errors.Is(err, ErrInvalidRange) {
				t.Fatalf("Finalize(%v) err = %v, want ErrInvalidRange", tc.r, err)
			}
		})
	}
	// 空范围为合法无操作。
	if _, merged, err := Redact(payload, []Range{{3, 3}}); err != nil || len(merged) != 0 {
		t.Fatalf("empty range: merged=%v err=%v", merged, err)
	}
}
