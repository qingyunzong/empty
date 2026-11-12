package dataeng_test

import (
	"encoding/binary"
	"hash/crc32"
)

// 独立编码器：测试专用，自行实现片格式，不调用被测包的任何编码辅助。
const (
	encBlockSize  = 32768
	encHeaderSize = 7
)

var encTable = crc32.MakeTable(crc32.Castagnoli)

func encMask(c uint32) uint32 {
	// rotateRight32(c,15) 即 RotateLeft32(c,-15)，再加常量并按 uint32 回绕。
	return (c>>15 | c<<17) + 0xa282ead8
}

func encCRC(typ byte, payload []byte) uint32 {
	h := crc32.New(encTable)
	h.Write([]byte{typ})
	h.Write(payload)
	return encMask(h.Sum32())
}

type encFragment struct {
	typ     byte
	start   int64
	payload []byte
}

type encRecord struct {
	logicalStart int64
	fragments    []encFragment
	payload      []byte
}

type encoder struct {
	buf     []byte
	records []encRecord
}

func (e *encoder) pos() int64 { return int64(len(e.buf)) }

// writeFragment 写一个片，自动处理块尾 0..6 字节的全零填充，不允许片跨块。
func (e *encoder) writeFragment(typ byte, payload []byte, rec *encRecord) int64 {
	blockLeft := encBlockSize - int(e.pos()%encBlockSize)
	if blockLeft < encHeaderSize {
		for i := 0; i < blockLeft; i++ {
			e.buf = append(e.buf, 0)
		}
		blockLeft = encBlockSize
	}
	if len(payload)+encHeaderSize > blockLeft {
		panic("fragment would cross block; split further")
	}

	start := e.pos()
	hdr := make([]byte, encHeaderSize)
	binary.LittleEndian.PutUint32(hdr[0:4], encCRC(typ, payload))
	binary.LittleEndian.PutUint16(hdr[4:6], uint16(len(payload)))
	hdr[6] = typ
	e.buf = append(e.buf, hdr...)
	e.buf = append(e.buf, payload...)

	if rec != nil {
		rec.fragments = append(rec.fragments, encFragment{typ: typ, start: start, payload: append([]byte(nil), payload...)})
	}
	return start
}

// zeroHeader 写一个完整零头并把块剩余部分填零。
func (e *encoder) zeroHeader() {
	blockLeft := encBlockSize - int(e.pos()%encBlockSize)
	if blockLeft < encHeaderSize {
		for i := 0; i < blockLeft; i++ {
			e.buf = append(e.buf, 0)
		}
		blockLeft = encBlockSize
	}
	for i := 0; i < blockLeft; i++ {
		e.buf = append(e.buf, 0)
	}
}

// zeroTail 追加 n 个裸零字节，用于制造“真正断电”的不完整填充/残头。
func (e *encoder) zeroTail(n int) {
	for i := 0; i < n; i++ {
		e.buf = append(e.buf, 0)
	}
}

func (e *encoder) raw(b ...byte) { e.buf = append(e.buf, b...) }

// PutFull 写一条 FULL 记录。
func (e *encoder) PutFull(payload []byte) {
	rec := &encRecord{payload: append([]byte(nil), payload...)}
	rec.logicalStart = e.writeFragment(1, payload, rec)
	e.records = append(e.records, *rec)
}

// PutChunks 写一条 FIRST…MIDDLE…LAST 记录。preferred 是期望的片载荷上限，
// 但片不得跨物理块：到达块边界时自动切分并插入 MIDDLE，确保任何长度都能编码。
// payload 为空时仍产出 FIRST+LAST 两个空片，覆盖“空片但遵循序列”的语义。
func (e *encoder) PutChunks(payload []byte, preferred ...int) {
	rec := &encRecord{payload: append([]byte(nil), payload...)}
	want := 0
	if len(preferred) > 0 {
		want = preferred[0]
	}
	if want <= 0 {
		want = encBlockSize / 2
	}

	if len(payload) == 0 {
		e.writeFragment(2, nil, rec)
		e.writeFragment(4, nil, rec)
		rec.logicalStart = rec.fragments[0].start
		e.records = append(e.records, *rec)
		return
	}

	off := 0
	first := true
	for off < len(payload) {
		blockLeft := encBlockSize - int(e.pos()%encBlockSize)
		if blockLeft < encHeaderSize {
			// 块尾不足 7 字节只能全零填充，下一片从新块开始。
			blockLeft = encBlockSize
		}
		avail := blockLeft - encHeaderSize
		n := len(payload) - off
		if n > avail {
			n = avail
		}
		if n > want {
			n = want
		}

		var typ byte
		switch {
		case first && off+n == len(payload):
			// 单片段逻辑记录也强制走 FIRST+LAST 两片，覆盖跨片路径。
			typ = 2
		case first:
			typ = 2
		case off+n == len(payload):
			typ = 4
		default:
			typ = 3
		}
		e.writeFragment(typ, payload[off:off+n], rec)
		off += n
		first = false

		// 若 FIRST 恰好吞掉全部载荷，补一个空 LAST 闭合。
		if off == len(payload) && rec.fragments[len(rec.fragments)-1].typ == 2 {
			e.writeFragment(4, nil, rec)
		}
	}

	rec.logicalStart = rec.fragments[0].start
	e.records = append(e.records, *rec)
}

// truncate 返回前 n 字节，模拟断电文件。
func (e *encoder) truncate(n int) []byte {
	out := make([]byte, n)
	copy(out, e.buf[:n])
	return out
}
