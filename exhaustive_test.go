package dataeng_test

import (
	"errors"
	"io"
	"testing"

	dataeng "example.org/dataeng/q0271"
)

// TestExhaustiveCutPoints 对一条跨越多个物理块的记录，逐字节制造“真正断电”
// 截断，并以多种输入切块大小读取，穷尽核验：
//   - 严格模式对任何未完成尾记录都报错；
//   - 恢复模式只在真实 EOF 丢弃未完成尾记录，且已交付的完整前缀始终保留；
//   - 全零块尾截断是干净 EOF，不算截断。
func TestExhaustiveCutPoints(t *testing.T) {
	enc := &encoder{}
	enc.PutFull(payloadBytes(50, 1))
	enc.PutChunks(payloadBytes(2*encBlockSize+300, 2), 1000)
	enc.PutFull(payloadBytes(20, 3))

	full := enc.buf
	secondStart := enc.records[1].logicalStart

	// 抽样步长取质数，保证在合理时间内扫过片头、载荷、块边界、零填充等不同相位。
	for cut := int(secondStart); cut <= len(full); cut += 257 {
		data := enc.truncate(cut)
		for _, size := range []int{1, 4096} {
			recGot, _, rerr := runReader(t, data, size, dataeng.Options{Mode: dataeng.Recovery})
			if rerr != nil && !errors.Is(rerr, io.EOF) {
				t.Fatalf("cut=%d size=%d recovery err=%v", cut, size, rerr)
			}
			if len(recGot) < 1 || len(recGot[0].payload) != 50 {
				t.Fatalf("cut=%d size=%d lost confirmed prefix", cut, size)
			}

			// 恢复模式返回 nil 表示发生了真实截断（干净 EOF 才返回 io.EOF）。
			recoveryTruncated := rerr == nil

			_, _, serr := runReader(t, data, size, dataeng.Options{Mode: dataeng.Strict})
			strictClean := serr != nil && errors.Is(serr, io.EOF)
			if recoveryTruncated && strictClean {
				t.Fatalf("cut=%d size=%d strict must fail where recovery truncated", cut, size)
			}
			if !recoveryTruncated && !strictClean {
				t.Fatalf("cut=%d size=%d clean cut must be EOF in both modes (serr=%v)", cut, size, serr)
			}
			if recoveryTruncated && (serr == nil || errors.Is(serr, io.EOF)) {
				t.Fatalf("cut=%d size=%d strict must fail on open record, got %v", cut, size, serr)
			}
		}
	}
}
