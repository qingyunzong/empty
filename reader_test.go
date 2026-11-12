package dataeng

import (
	"fmt"
	"io"
	"math"
)

// memReader 是自行编码的测试夹具：底层是一块字节数据，记录每次
// ReadAt，并可注入故障/截断以及强制区间边界。
type memReader struct {
	data        []byte
	calls       []ReadCall
	failAt      int64 // != math.MinInt64 时，读取覆盖该偏移即返回错误
	limit       int64 // >=0 时最多返回该长度模拟短读；默认 -1 表示不限制
	denyOutside *Range
}

func newMemReader(data []byte) *memReader {
	return &memReader{data: append([]byte(nil), data...), failAt: math.MinInt64, limit: -1}
}

func (m *memReader) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 {
		return 0, fmt.Errorf("negative offset %d", off)
	}
	if m.denyOutside != nil {
		end := off + int64(len(p))
		if off < m.denyOutside.Offset || end > m.denyOutside.Offset+m.denyOutside.Length {
			return 0, fmt.Errorf("read [%d,%d) escapes permitted interval", off, end)
		}
	}
	m.calls = append(m.calls, ReadCall{Offset: off, Length: int64(len(p))})
	if m.failAt != math.MinInt64 && off <= m.failAt && m.failAt < off+int64(len(p)) {
		return 0, io.ErrUnexpectedEOF
	}
	if off >= int64(len(m.data)) {
		return 0, io.EOF
	}
	n := copy(p, m.data[off:])
	if m.limit >= 0 && int64(n) > m.limit {
		n = int(m.limit)
	}
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func (m *memReader) callCount() int { return len(m.calls) }

// 以下为大端编码辅助。
func be16(v int16) []byte {
	return []byte{byte(v >> 8), byte(v)}
}

func be32(v int32) []byte {
	return []byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}
}

func be64(v int64) []byte {
	u := uint64(v)
	return []byte{
		byte(u >> 56), byte(u >> 48), byte(u >> 40), byte(u >> 32),
		byte(u >> 24), byte(u >> 16), byte(u >> 8), byte(u),
	}
}

func descP(count int32, offset int32) []byte {
	return append(be32(count), be32(offset)...)
}

func descQ(count int64, offset int64) []byte {
	return append(be64(count), be64(offset)...)
}

func putAt(dst []byte, off int, src ...[]byte) {
	for _, s := range src {
		copy(dst[off:], s)
		off += len(s)
	}
}

func i64ptr(v int64) *int64 { return &v }

// guardReader 把任何超出表区间的读取视为测试失败。
type guardReader struct {
	inner    *memReader
	tableEnd int64
}

func (g *guardReader) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 || off+int64(len(p)) > g.tableEnd {
		return 0, fmt.Errorf("illegal read [%d,%d), table ends at %d", off, off+int64(len(p)), g.tableEnd)
	}
	return g.inner.ReadAt(p, off)
}
