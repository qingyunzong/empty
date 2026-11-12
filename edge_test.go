package dataeng_test

import (
	"io"
	"testing"

	dataeng "example.org/dataeng/q0271"
)

func TestEmptyFile(t *testing.T) {
	for _, mode := range []dataeng.Mode{dataeng.Strict, dataeng.Recovery} {
		got, trunc, err := runReader(t, nil, 4, dataeng.Options{Mode: mode})
		if err != io.EOF {
			t.Fatalf("mode=%d err=%v want EOF", mode, err)
		}
		if len(got) != 0 || trunc != nil {
			t.Fatalf("empty file produced records=%d trunc=%v", len(got), trunc)
		}
	}
}

func TestAllZeroBlocks(t *testing.T) {
	// 整块全零（不足 7 字节尾部与零头填充的极端组合）在两种模式下都是干净 EOF。
	data := make([]byte, encBlockSize+13)
	for _, mode := range []dataeng.Mode{dataeng.Strict, dataeng.Recovery} {
		got, trunc, err := runReader(t, data, 7, dataeng.Options{Mode: mode})
		if err != io.EOF {
			t.Fatalf("mode=%d err=%v", mode, err)
		}
		if len(got) != 0 || trunc != nil {
			t.Fatalf("zero blocks produced records=%d trunc=%v", len(got), trunc)
		}
	}
}

func TestRecoveryCleanEOFHasNoTruncation(t *testing.T) {
	enc := &encoder{}
	enc.PutFull(payloadBytes(10, 1))
	enc.PutChunks(payloadBytes(33000, 2), 1000)
	got, trunc, err := runReader(t, enc.buf, 123, dataeng.Options{Mode: dataeng.Recovery})
	if err != io.EOF {
		t.Fatalf("err=%v", err)
	}
	if trunc != nil {
		t.Fatalf("clean EOF must not report truncation: %+v", trunc)
	}
	if len(got) != 2 {
		t.Fatalf("records=%d want 2", len(got))
	}
}

func TestResumeAtZero(t *testing.T) {
	enc := buildMixedLog(t)
	zero := dataeng.Checkpoint{} // 零值即空前缀检查点
	got, _, err := runReader(t, enc.buf, 999, dataeng.Options{Mode: dataeng.Strict, Resume: &zero})
	if err != io.EOF {
		t.Fatalf("resume at zero err=%v", err)
	}
	verifyRecords(t, enc, got)
}
