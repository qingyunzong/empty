package dataeng

import (
	"encoding/binary"
	"testing"
)

// mem assembles a FlatBuffers-style buffer at explicit absolute positions,
// giving tests direct control over vtables, signed vtable distances and
// shared objects. Every byte is placed deliberately.
type mem struct {
	buf []byte
}

func newMem(size int) *mem { return &mem{buf: make([]byte, size)} }

func (m *mem) u8(pos uint32, v uint8)   { m.buf[pos] = v }
func (m *mem) u16(pos uint32, v uint16) { binary.LittleEndian.PutUint16(m.buf[pos:], v) }
func (m *mem) u32(pos uint32, v uint32) { binary.LittleEndian.PutUint32(m.buf[pos:], v) }
func (m *mem) i32(pos uint32, v int32)  { m.u32(pos, uint32(v)) }
func (m *mem) u64(pos uint32, v uint64) { binary.LittleEndian.PutUint64(m.buf[pos:], v) }
func (m *mem) i64(pos uint32, v int64)  { m.u64(pos, uint64(v)) }

func (m *mem) bytes(pos uint32, p []byte) { copy(m.buf[pos:], p) }

// ref stores a positive relative offset at fieldPos pointing at target.
func (m *mem) ref(fieldPos, target uint32) {
	m.u32(fieldPos, uint32(int32(target)-int32(fieldPos)))
}

// root makes pos the root table: the first uint32 is the offset to the root.
func (m *mem) root(pos uint32) { m.u32(0, pos-4) }

// vtable writes a vtable and returns its start position.
func (m *mem) vtable(pos uint32, objectLen uint16, offsets ...uint16) uint32 {
	m.u16(pos, uint16(4+2*len(offsets)))
	m.u16(pos+2, objectLen)
	for i, off := range offsets {
		m.u16(pos+4+uint32(i)*2, off)
	}
	return pos
}

// table writes the signed vtable distance at tablePos and returns the
// distance. vtablePos may be greater than tablePos, yielding a negative d.
func (m *mem) table(tablePos, vtablePos uint32) int32 {
	d := int32(tablePos) - int32(vtablePos)
	m.i32(tablePos, d)
	return d
}

// stringAt writes length, payload and a NUL terminator.
func (m *mem) stringAt(pos uint32, s string) uint32 {
	m.u32(pos, uint32(len(s)))
	m.bytes(pos+4, []byte(s))
	m.u8(pos+4+uint32(len(s)), 0)
	return pos
}

func mustTable(t *testing.T, name string, fields ...Field) *Table {
	t.Helper()
	tab, err := NewTable(name, fields...)
	if err != nil {
		t.Fatalf("NewTable(%s): %v", name, err)
	}
	return tab
}

func mustI32(t *testing.T, v *Value) int32 {
	t.Helper()
	got, ok := v.I32()
	if !ok {
		t.Fatalf("value %+v is not i32", v)
	}
	return got
}
