package dataeng_test

import (
	"testing"

	dataeng "example.org/dataeng/q0271"
)

func TestCRCCorruption(t *testing.T) {
	enc := &encoder{}
	enc.PutChunks(payloadBytes(50000, 7), 1234)
	bad := append([]byte(nil), enc.buf...)
	frag := enc.records[0].fragments[1]
	target := frag.start + encHeaderSize + 3
	bad[target] ^= 0xFF

	for _, size := range []int{1, 7, 1000, 32768} {
		got, _, err := runReader(t, bad, size, dataeng.Options{Mode: dataeng.Recovery})
		assertKind(t, err, dataeng.ErrCRC, frag.start)
		if len(got) != 0 {
			t.Fatalf("size=%d delivered records despite CRC failure", size)
		}
	}
}

func TestBlockOverrun(t *testing.T) {
	enc := &encoder{}
	enc.PutFull(payloadBytes(10, 1))
	enc.zeroHeader()
	off := enc.pos()
	// 声明长度等于整块，头+长度必然超出块剩余空间。
	enc.raw(makeRawHeader(1, encBlockSize)...)
	enc.zeroTail(encBlockSize - int(enc.pos()-off))
	_, _, err := runReader(t, enc.buf, 123, dataeng.Options{Mode: dataeng.Recovery})
	assertKind(t, err, dataeng.ErrBlockOverrun, off)
}

func TestIllegalType(t *testing.T) {
	enc := &encoder{}
	off := enc.pos()
	enc.raw(makeRawHeader(9, 0)...)
	enc.zeroTail(50)
	_, _, err := runReader(t, enc.buf, 7, dataeng.Options{Mode: dataeng.Recovery})
	assertKind(t, err, dataeng.ErrIllegalType, off)
}

func TestNonZeroShortTail(t *testing.T) {
	enc := &encoder{}
	enc.PutFull(payloadBytes(encBlockSize-encHeaderSize-3, 1))
	off := enc.pos()
	enc.raw(0, 0, 1) // 不足 7 字节的块尾出现非零
	_, _, err := runReader(t, enc.buf, 2, dataeng.Options{Mode: dataeng.Recovery})
	assertKind(t, err, dataeng.ErrBadPadding, off+2)
}

func TestNonZeroAfterZeroHeader(t *testing.T) {
	enc := &encoder{}
	enc.PutFull(payloadBytes(5, 1))
	off := enc.pos()
	enc.zeroHeader()
	enc.buf[off+9] = 1 // 零头要求块剩余全零
	_, _, err := runReader(t, enc.buf, 4, dataeng.Options{Mode: dataeng.Recovery})
	assertKind(t, err, dataeng.ErrBadPadding, off+9)
}

func TestSequenceErrors(t *testing.T) {
	t.Run("middle without first", func(t *testing.T) {
		enc := &encoder{}
		off := enc.writeFragment(3, payloadBytes(4, 1), nil)
		_, _, err := runReader(t, enc.buf, 3, dataeng.Options{Mode: dataeng.Recovery})
		assertKind(t, err, dataeng.ErrSequence, off)
	})

	t.Run("full while assembling", func(t *testing.T) {
		enc := &encoder{}
		enc.writeFragment(2, payloadBytes(4, 1), nil)
		fullOff := enc.writeFragment(1, payloadBytes(4, 2), nil)
		_, _, err := runReader(t, enc.buf, 11, dataeng.Options{Mode: dataeng.Recovery})
		assertKind(t, err, dataeng.ErrSequence, fullOff)
	})

	t.Run("last without first", func(t *testing.T) {
		enc := &encoder{}
		off := enc.writeFragment(4, payloadBytes(4, 1), nil)
		_, _, err := runReader(t, enc.buf, 64, dataeng.Options{Mode: dataeng.Recovery})
		assertKind(t, err, dataeng.ErrSequence, off)
	})

	t.Run("first while assembling", func(t *testing.T) {
		enc := &encoder{}
		firstOff := enc.writeFragment(2, payloadBytes(4, 1), nil)
		secondOff := enc.writeFragment(2, payloadBytes(4, 2), nil)
		_ = firstOff
		_, _, err := runReader(t, enc.buf, 30, dataeng.Options{Mode: dataeng.Recovery})
		assertKind(t, err, dataeng.ErrSequence, secondOff)
	})
}
