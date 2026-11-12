package dataeng

import (
	"bytes"
	"math"
	"testing"
)

func TestEncodeBlockOverflowPositive(t *testing.T) {
	samples := []int64{math.MinInt64, math.MaxInt64}
	got, err := EncodeBlock(samples)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	// 头(2) + 首值(8) + 65 位负载向上取整为 9 字节 = 19。
	want := []byte{
		2, 65,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, // MinInt64 小端
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // 差值低 64 位全 1
		0x00, // 第 65 位符号位 0（正），位于末字节最低位；其余填充位为 0
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("positive overflow bytes = % x, want % x", got, want)
	}
	decoded, err := Decode(got)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !intsEqual(decoded, samples) {
		t.Fatalf("decoded = %d, want %d", decoded, samples)
	}
}

func TestEncodeBlockOverflowNegative(t *testing.T) {
	samples := []int64{math.MaxInt64, math.MinInt64}
	got, err := EncodeBlock(samples)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	want := []byte{
		2, 65,
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, // MaxInt64 小端
		0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 差值低 64 位为 1
		0x01, // 第 65 位符号位 1（负），位于末字节最低位；其余填充位为 0
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("negative overflow bytes = % x, want % x", got, want)
	}
	decoded, err := Decode(got)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !intsEqual(decoded, samples) {
		t.Fatalf("decoded = %d, want %d", decoded, samples)
	}
}

func TestEncodeBlockNonByteAlignedPadding(t *testing.T) {
	// 差值 +2 各需 3 位（二补码 010），3 个差值共 9 位 -> 2 字节负载，高 7 位补零。
	samples := []int64{10, 12, 14, 16}
	got, err := EncodeBlock(samples)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	want := []byte{
		4, 3,
		10, 0, 0, 0, 0, 0, 0, 0,
		0x92, 0x00, // 位流 010 010 010（低位在前）=> 10010010 00000000
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("padding bytes = % x, want % x", got, want)
	}
	decoded, err := Decode(got)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !intsEqual(decoded, samples) {
		t.Fatalf("decoded = %d, want %d", decoded, samples)
	}

	// 翻转一个填充位必须报错。
	bad := bytes.Clone(got)
	bad[len(bad)-1] |= 0x02 // 第二字节除最低位外均为填充区
	if _, err := Decode(bad); err != ErrNonZeroPadding {
		t.Fatalf("padding error = %v, want ErrNonZeroPadding", err)
	}
}

func TestZeroBitWidthBlock(t *testing.T) {
	samples := []int64{7, 7, 7}
	got, err := EncodeBlock(samples)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	// b=0：无差值负载，块仅 10 字节。
	want := []byte{3, 0, 7, 0, 0, 0, 0, 0, 0, 0}
	if !bytes.Equal(got, want) {
		t.Fatalf("zero-width bytes = % x, want % x", got, want)
	}
	decoded, err := Decode(got)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !intsEqual(decoded, samples) {
		t.Fatalf("decoded = %d, want %d", decoded, samples)
	}
}

func TestMultiSample65BitRoundTrip(t *testing.T) {
	// 三个样本、两条 65 位差值：共 130 位 -> 17 字节负载（含 6 个填充位）。
	samples := []int64{math.MinInt64, math.MaxInt64, math.MinInt64}
	got, err := EncodeBlock(samples)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if want := blockOverhead + 17; len(got) != want {
		t.Fatalf("length=%d want=%d", len(got), want)
	}
	decoded, err := Decode(got)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !intsEqual(decoded, samples) {
		t.Fatalf("decoded=%d want=%d", decoded, samples)
	}

	// 翻转最后一个填充位（130..135 位均为填充位）。
	bad := bytes.Clone(got)
	padBit := 130
	bad[10+padBit/8] |= 1 << (padBit % 8)
	if _, err := Decode(bad); err != ErrNonZeroPadding {
		t.Fatalf("padding error=%v want ErrNonZeroPadding", err)
	}
}

func TestEncodeBlockLimits(t *testing.T) {
	if _, err := EncodeBlock(nil); err != ErrEmptyBlock {
		t.Fatalf("empty block err = %v", err)
	}
	if _, err := EncodeBlock(make([]int64, 65)); err != ErrBlockTooLarge {
		t.Fatalf("oversized block err = %v", err)
	}
}

func TestEmptyColumn(t *testing.T) {
	encoded, plan, err := EncodeColumn(nil)
	if err != nil {
		t.Fatalf("encode empty: %v", err)
	}
	if len(encoded) != 0 || plan.BlockCount() != 0 || plan.TotalBytes() != 0 {
		t.Fatalf("empty column not zero: %d bytes, %d blocks", len(encoded), plan.BlockCount())
	}
	decoded, err := Decode(nil)
	if err != nil {
		t.Fatalf("decode empty: %v", err)
	}
	if len(decoded) != 0 {
		t.Fatalf("decoded empty = %v", decoded)
	}
	cert := plan.Certificate()
	if cert.BlockCount != 0 || cert.TotalBytes != 0 || len(cert.Blocks) != 0 {
		t.Fatalf("empty certificate = %+v", cert)
	}
}

func TestDecodeErrors(t *testing.T) {
	cases := map[string][]byte{
		"truncated header":       {64, 2},
		"zero sample count":      {0, 1, 0, 0, 0, 0, 0, 0, 0, 0},
		"invalid bit width":      {1, 66, 0, 0, 0, 0, 0, 0, 0, 0},
		"truncated first value":  {1, 0, 1, 2, 3},
		"truncated payload":      {2, 8, 0, 0, 0, 0, 0, 0, 0, 0},
		"block too large header": {65, 0},
	}
	for name, data := range cases {
		if _, err := Decode(data); err == nil {
			t.Errorf("%s: expected error, got nil", name)
		}
	}
}

func intsEqual(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
