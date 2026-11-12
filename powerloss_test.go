package dataeng_test

import (
	"errors"
	"io"
	"testing"

	dataeng "example.org/dataeng/q0271"
)

func TestPowerLossTails(t *testing.T) {
	enc := &encoder{}
	enc.PutFull(payloadBytes(100, 1))
	enc.PutChunks(payloadBytes(40000, 2), 777)

	// 取长记录最后一个片的片头：在它内部或其载荷内部截断，分类才确定。
	lastFrag := enc.records[1].fragments[len(enc.records[1].fragments)-1]
	hdrStart := int(lastFrag.start)

	cases := []struct {
		name   string
		cut    int
		reason dataeng.TruncationReason
	}{
		{"header partial 3", hdrStart + 3, dataeng.TruncatedHeader},
		{"header partial 6", hdrStart + 6, dataeng.TruncatedHeader},
		{"payload partial", hdrStart + encHeaderSize + 5, dataeng.TruncatedPayload},
		{"payload partial larger", hdrStart + encHeaderSize + 40, dataeng.TruncatedPayload},
	}

	for _, tc := range cases {
		data := enc.truncate(tc.cut)
		for _, size := range []int{1, 2, 7, 99, 32768} {
			_, _, serr := runReader(t, data, size, dataeng.Options{Mode: dataeng.Strict})
			if serr == nil || errors.Is(serr, io.EOF) {
				t.Fatalf("%s size=%d strict err=%v want failure", tc.name, size, serr)
			}

			got, trunc, rerr := runReader(t, data, size, dataeng.Options{Mode: dataeng.Recovery})
			if rerr != nil {
				t.Fatalf("%s size=%d recovery err=%v", tc.name, size, rerr)
			}
			if trunc == nil {
				t.Fatalf("%s size=%d missing truncation report", tc.name, size)
			}
			if trunc.Reason != tc.reason {
				t.Fatalf("%s reason=%v want=%v", tc.name, trunc.Reason, tc.reason)
			}
			// 第一条完整 FULL 必须保留；第二条长记录被整体丢弃。
			if len(got) != 1 || len(got[0].payload) != 100 {
				t.Fatalf("%s size=%d prefix preserved=%d", tc.name, size, len(got))
			}
			if trunc.BytesDropped != int64(len(data))-trunc.LogicalStart {
				t.Fatalf("%s dropped=%d inconsistent", tc.name, trunc.BytesDropped)
			}
		}
	}
}

func TestUnclosedRecordAtEOF(t *testing.T) {
	enc := &encoder{}
	enc.PutFull(payloadBytes(10, 1))
	firstStart := enc.writeFragment(2, payloadBytes(20, 2), nil)
	enc.writeFragment(3, payloadBytes(20, 3), nil)
	// 缺 LAST，直接 EOF。

	_, _, serr := runReader(t, enc.buf, 64, dataeng.Options{Mode: dataeng.Strict})
	assertKind(t, serr, dataeng.ErrUnclosedRecord, firstStart)

	got, trunc, err := runReader(t, enc.buf, 64, dataeng.Options{Mode: dataeng.Recovery})
	if err != nil {
		t.Fatalf("recovery err=%v", err)
	}
	if trunc == nil || trunc.Reason != dataeng.UnclosedRecord || trunc.LogicalStart != firstStart {
		t.Fatalf("bad truncation %+v start=%d", trunc, firstStart)
	}
	if len(got) != 1 {
		t.Fatalf("prefix records=%d want 1", len(got))
	}
}

func TestAllZeroTailIsCleanEOF(t *testing.T) {
	for remain := 1; remain <= 6; remain++ {
		enc := &encoder{}
		enc.zeroHeader() // 对齐到块边界
		// 在块内写一条 FULL，使块尾恰好剩 remain 字节，再以全零填充收尾。
		enc.PutFull(payloadBytes(encBlockSize-encHeaderSize-remain, 2))
		enc.zeroTail(remain)

		for _, size := range []int{1, 3, remain, 32768} {
			got, trunc, err := runReader(t, enc.buf, size, dataeng.Options{Mode: dataeng.Recovery})
			if err != io.EOF {
				t.Fatalf("remain=%d size=%d err=%v", remain, size, err)
			}
			if trunc != nil {
				t.Fatalf("remain=%d zero tail must not be truncation", remain)
			}
			if len(got) != 1 {
				t.Fatalf("remain=%d size=%d records=%d", remain, size, len(got))
			}
		}
	}
}

func TestZeroHeaderNotAnEmptyRecord(t *testing.T) {
	enc := &encoder{}
	enc.PutFull(nil) // 真正的空 FULL
	enc.zeroHeader()
	enc.PutFull(payloadBytes(5, 1))
	enc.zeroHeader()

	got, _, err := runReader(t, enc.buf, 17, dataeng.Options{Mode: dataeng.Strict})
	if err != io.EOF {
		t.Fatalf("err=%v", err)
	}
	if len(got) != 2 {
		t.Fatalf("zero header counted as record: got %d want 2", len(got))
	}
}
