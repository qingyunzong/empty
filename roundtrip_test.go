package dataeng_test

import (
	"errors"
	"io"
	"testing"

	dataeng "example.org/dataeng/q0271"
)

func buildMixedLog(t *testing.T) *encoder {
	t.Helper()
	enc := &encoder{}
	enc.PutFull(nil)                            // 空 FULL
	enc.PutFull(payloadBytes(100, 1))           // 小 FULL
	enc.PutChunks(payloadBytes(40000, 2), 100)  // 跨块长记录
	enc.PutChunks(payloadBytes(32700, 3), 500)  // 逼近块边界
	enc.PutFull(payloadBytes(1, 4))             // 极小 FULL
	enc.PutChunks(payloadBytes(70000, 5), 333)  // 多块记录
	enc.PutChunks(nil, 0)                       // 空 FIRST/LAST
	enc.PutChunks(payloadBytes(25000, 6), 4096) // 块内分片记录
	for enc.pos()%encBlockSize != 0 {
		enc.zeroHeader()
	}
	return enc
}

func TestAllChunkSizesMixed(t *testing.T) {
	enc := buildMixedLog(t)
	sizes := []int{1, 2, 3, 6, 7, 8, 13, 64, 257, 4096, 32767, 32768, 65537}
	for _, size := range sizes {
		got, trunc, err := runReader(t, enc.buf, size, dataeng.Options{Mode: dataeng.Strict})
		if err != io.EOF {
			t.Fatalf("chunk %d: err=%v want EOF", size, err)
		}
		if trunc != nil {
			t.Fatalf("chunk %d: unexpected truncation", size)
		}
		verifyRecords(t, enc, got)
	}
}

func TestTailBoundaryOneToEight(t *testing.T) {
	for remain := 1; remain <= 8; remain++ {
		enc := &encoder{}
		enc.PutFull(payloadBytes(10, byte(remain)))
		enc.zeroHeader()
		// 在新块写一条使块尾恰好剩 remain 字节的 FULL，再补全零断电尾。
		enc.PutFull(payloadBytes(encBlockSize-encHeaderSize-remain, 9))
		enc.zeroTail(remain)

		for _, size := range []int{1, remain, encHeaderSize, 100, 32768} {
			got, _, err := runReader(t, enc.buf, size, dataeng.Options{Mode: dataeng.Strict})
			if err != io.EOF {
				t.Fatalf("remain=%d chunk=%d: err=%v", remain, size, err)
			}
			if len(got) != 2 {
				t.Fatalf("remain=%d chunk=%d: got %d records", remain, size, len(got))
			}
		}
	}
}

func TestEmptyRecords(t *testing.T) {
	enc := &encoder{}
	enc.PutFull(nil)
	enc.PutChunks(nil, 0)
	enc.PutFull(nil)
	got, _, err := runReader(t, enc.buf, 5, dataeng.Options{Mode: dataeng.Strict})
	if err != io.EOF {
		t.Fatalf("err=%v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d empty records, want 3", len(got))
	}
	for _, rec := range got {
		if len(rec.payload) != 0 || rec.ranges[0].Length != 0 {
			t.Fatalf("empty record not represented with zero-length range")
		}
	}
}

func TestLongRecordSpansEveryBlockCut(t *testing.T) {
	// 一条远大于块的记录；对文件的每个物理切点（步长抽样）都核验切块读取。
	enc := &encoder{}
	enc.PutFull(payloadBytes(50, 1))
	enc.PutChunks(payloadBytes(3*encBlockSize+123, 2), 777)
	enc.PutFull(payloadBytes(50, 3))

	for _, size := range []int{1, 5, 31, 32768, 32769, 50000} {
		got, _, err := runReader(t, enc.buf, size, dataeng.Options{Mode: dataeng.Strict})
		if !errors.Is(err, io.EOF) {
			t.Fatalf("size=%d err=%v", size, err)
		}
		verifyRecords(t, enc, got)
	}
}
