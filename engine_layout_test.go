package dataeng

import (
	"encoding/binary"
	"math"
	"testing"
)

// 场景4：不同宽度交错，i16/i32/f64bits 在同一 chunk 轮流存放。
func TestInterleavedMixedWidths(t *testing.T) {
	eng, _ := New(testBudget())
	// 每通道 n=2，宽度 2/4/8，stride=14，chunk=28 字节，共两个 chunk。
	raw := make([]byte, 56)
	bo := binary.LittleEndian
	stride := 14
	offsets := map[string]int{"/a": 0, "/b": 2, "/c": 6}
	aVals := []int16{11, 12, 13, 14}
	bVals := []int32{21, 22, 23, 24}
	cBits := []uint64{
		math.Float64bits(10), math.Float64bits(12),
		math.Float64bits(14), math.Float64bits(16),
	}
	for sample := 0; sample < 4; sample++ {
		chunk := sample / 2
		idx := sample % 2
		base := chunk*stride*2 + idx*stride
		bo.PutUint16(raw[base+offsets["/a"]:], uint16(aVals[sample]))
		bo.PutUint32(raw[base+offsets["/b"]:], uint32(bVals[sample]))
		bo.PutUint64(raw[base+offsets["/c"]:], cBits[sample])
	}

	mustIngest(t, eng, rawSeg(1, LittleEndian, true, LayoutInterleaved, []Update{
		{Path: "/a", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 2},
		{Path: "/b", Kind: IndexNew, Type: TypeI32, SamplesPerChunk: 2},
		{Path: "/c", Kind: IndexNew, Type: TypeF64Bits, SamplesPerChunk: 2},
	}, raw))

	ha, _ := eng.Open("/a", 0, 4)
	ra := readAll(t, ha)
	for i, r := range ra {
		if r.I16 != aVals[i] {
			t.Fatalf("a[%d]=%d want %d", i, r.I16, aVals[i])
		}
		wantOff := (i/2)*28 + (i%2)*14
		if r.Source.PhysicalOffset != int64(wantOff) || r.Source.Chunk != int64(i/2) {
			t.Fatalf("a[%d] source = %+v", i, r.Source)
		}
	}

	hb, _ := eng.Open("/b", 0, 4)
	rb := readAll(t, hb)
	for i, r := range rb {
		if r.I32 != bVals[i] {
			t.Fatalf("b[%d]=%d want %d", i, r.I32, bVals[i])
		}
		wantOff := (i/2)*28 + (i%2)*14 + 2
		if r.Source.PhysicalOffset != int64(wantOff) {
			t.Fatalf("b[%d] offset = %d want %d", i, r.Source.PhysicalOffset, wantOff)
		}
	}

	hc, _ := eng.Open("/c", 0, 4)
	rc := readAll(t, hc)
	for i, r := range rc {
		// f64bits 必须原样返回 IEEE 位型，不做十进制转换。
		if r.F64 != cBits[i] {
			t.Fatalf("c[%d]=%#x want %#x", i, r.F64, cBits[i])
		}
		if r.Source.Width != 8 {
			t.Fatalf("c width = %d", r.Source.Width)
		}
	}

	// 交错布局 n 不一致必须拒绝。
	err := eng.Ingest(rawSeg(2, LittleEndian, true, LayoutInterleaved, []Update{
		{Path: "/a", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 2},
		{Path: "/b", Kind: IndexNew, Type: TypeI32, SamplesPerChunk: 3},
	}, make([]byte, 2*2+3*4)))
	assertReject(t, err, ErrRawLayout)
}

// 场景5：两种端序下的负 timestamp，先 uint64 亚秒再 int64 秒。
func TestTimestampBothEndiansNegative(t *testing.T) {
	cases := []struct {
		name string
		e    Endian
	}{
		{"little", LittleEndian},
		{"big", BigEndian},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			eng, _ := New(testBudget())
			ts1 := Timestamp{Fraction: 1 << 63, Seconds: -5}
			ts2 := Timestamp{Fraction: 42, Seconds: -1}
			raw := make([]byte, 32)
			putTestValue(raw[0:16], tc.e, TypeTimestamp, ts1)
			putTestValue(raw[16:32], tc.e, TypeTimestamp, ts2)

			mustIngest(t, eng, rawSeg(1, tc.e, true, LayoutContiguous, []Update{
				{Path: "/t", Kind: IndexNew, Type: TypeTimestamp, SamplesPerChunk: 2},
			}, raw))

			h, _ := eng.Open("/t", 0, 2)
			rs := readAll(t, h)
			if rs[0].Time != ts1 {
				t.Fatalf("ts1 = %+v want %+v", rs[0].Time, ts1)
			}
			if rs[1].Time != ts2 {
				t.Fatalf("ts2 = %+v want %+v", rs[1].Time, ts2)
			}
			if rs[0].Source.Width != 16 || rs[1].Source.PhysicalOffset != 16 {
				t.Fatalf("timestamp source = %+v %+v", rs[0].Source, rs[1].Source)
			}
			if rs[0].Time.Seconds >= 0 {
				t.Fatalf("seconds must decode as signed negative, got %d", rs[0].Time.Seconds)
			}
		})
	}
}
