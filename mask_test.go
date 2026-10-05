package mask

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
)

func TestMergeRangesUnion(t *testing.T) {
	got, err := MergeRanges([]Range{{10, 15}, {2, 5}, {4, 8}, {20, 22}, {21, 25}, {30, 30}})
	if err != nil {
		t.Fatalf("MergeRanges: %v", err)
	}
	want := []Range{{2, 8}, {10, 15}, {20, 25}}
	if fmt.Sprintf("%v", got) != fmt.Sprintf("%v", want) {
		t.Fatalf("merged = %v, want %v", got, want)
	}
}

func TestMergeRangesInvalid(t *testing.T) {
	if _, err := MergeRanges([]Range{{5, 3}}); err == nil {
		t.Fatal("expected error for Start > End")
	}
	if _, err := MergeRanges([]Range{{-1, 3}}); err == nil {
		t.Fatal("expected error for negative Start")
	}
}

const sample = "user=alice; password=secret123; note=hello token=tok_ABZ99 tail"

func sampleRanges() []Range {
	pw := strings.Index(sample, "secret123")
	tk := strings.Index(sample, "tok_ABZ99")
	// 故意重叠：password 值被两个重叠范围覆盖，测试求并。
	return []Range{{pw, pw + 6}, {pw + 4, pw + 9}, {tk, tk + 9}}
}

func TestMaskSameLength(t *testing.T) {
	out, pm, err := Mask([]byte(sample), sampleRanges(), Options{Strategy: SameLength})
	if err != nil {
		t.Fatalf("Mask: %v", err)
	}
	if len(out) != len(sample) {
		t.Fatalf("SameLength changed length: got %d, want %d", len(out), len(sample))
	}
	if bytes.Contains(out, []byte("secret")) || bytes.Contains(out, []byte("tok_ABZ99")) {
		t.Fatalf("sensitive plaintext leaked: %q", out)
	}
	merged, _ := MergeRanges(sampleRanges())
	for _, r := range merged {
		for i := r.Start; i < r.End; i++ {
			if out[i] != '*' {
				t.Fatalf("offset %d not masked: %q", i, out[i])
			}
		}
	}
	// 非敏感字节原样保留。
	masked := make([]bool, len(sample))
	for _, r := range merged {
		for i := r.Start; i < r.End; i++ {
			masked[i] = true
		}
	}
	for i := range sample {
		if !masked[i] && out[i] != sample[i] {
			t.Fatalf("non-sensitive byte %d altered: %q -> %q", i, sample[i], out[i])
		}
	}
	// 同长策略下位置图为恒等映射。
	for _, o := range []int{0, 7, 25, 40, len(sample)} {
		if pm.ToMasked(o) != o || pm.ToOrig(o) != o {
			t.Fatalf("identity mapping broken at %d: %d/%d", o, pm.ToMasked(o), pm.ToOrig(o))
		}
	}
}

func TestMaskDigest(t *testing.T) {
	src := []byte(sample)
	out, pm, err := Mask(src, sampleRanges(), Options{Strategy: Digest})
	if err != nil {
		t.Fatalf("Mask: %v", err)
	}
	if bytes.Contains(out, []byte("secret")) || bytes.Contains(out, []byte("tok_ABZ99")) {
		t.Fatalf("sensitive plaintext leaked: %q", out)
	}
	merged, _ := MergeRanges(sampleRanges())
	// 校验每段替换内容确为原敏感字节的 sha256 摘要。
	for _, r := range merged {
		sum := sha256.Sum256(src[r.Start:r.End])
		want := "<sha256:" + hex.EncodeToString(sum[:]) + ">"
		if !bytes.Contains(out, []byte(want)) {
			t.Fatalf("digest for [%d,%d) missing: want %q in %q", r.Start, r.End, want, out)
		}
	}
	// 摘要替换改变长度，位置图反映位移。
	if pm.MaskedLen() != len(out) || pm.OrigLen() != len(src) {
		t.Fatalf("posmap lengths wrong: %d/%d", pm.MaskedLen(), pm.OrigLen())
	}
	if pm.ToMasked(len(src)) != len(out) || pm.ToOrig(len(out)) != len(src) {
		t.Fatal("end offsets not mapped")
	}
	// 敏感区段内：原始偏移 -> 替换起点；替换内偏移 -> 原始起点。
	r0 := merged[0]
	ms := pm.ToMasked(r0.Start)
	if pm.ToMasked(r0.Start+3) != ms {
		t.Fatal("offset inside sensitive range should map to replacement start")
	}
	if pm.ToOrig(ms+5) != r0.Start {
		t.Fatal("offset inside replacement should map back to sensitive range start")
	}
	// 保留区段双向可逆。
	for _, o := range []int{0, 3, r0.End + 2, len(src) - 2} {
		inside := false
		for _, r := range merged {
			if o >= r.Start && o < r.End {
				inside = true
			}
		}
		if inside {
			continue
		}
		if pm.ToOrig(pm.ToMasked(o)) != o {
			t.Fatalf("roundtrip failed at %d: %d", o, pm.ToOrig(pm.ToMasked(o)))
		}
	}
	// 保留字节在位移后内容一致。
	tail := src[merged[len(merged)-1].End:]
	if !bytes.HasSuffix(out, tail) {
		t.Fatalf("preserved tail missing in output: %q", out)
	}
}

func TestMaskRangeOutOfBounds(t *testing.T) {
	if _, _, err := Mask([]byte("abc"), []Range{{0, 4}}, Options{Strategy: SameLength}); err == nil {
		t.Fatal("expected error for range beyond input")
	}
}

func TestMaskCustomMaskByte(t *testing.T) {
	out, _, err := Mask([]byte("a=hidden b"), []Range{{2, 8}}, Options{Strategy: SameLength, MaskByte: '#'})
	if err != nil {
		t.Fatalf("Mask: %v", err)
	}
	if string(out) != "a=###### b" {
		t.Fatalf("got %q", out)
	}
}
