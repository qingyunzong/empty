package dataeng

import (
	"bytes"
	"fmt"
	"io"
	"testing"
)

const (
	rs byte = 0x1d
	ft byte = 0x1e
	sf byte = 0x1f
)

// encodedField is one physically encoded field body without the record-level
// terminator. Every field already carries its trailing 0x1e.
type encodedField struct {
	tag  string
	body []byte // includes the trailing field terminator
}

func controlField(tag, content string) encodedField {
	return encodedField{tag: tag, body: append([]byte(content), ft)}
}

// sub is one subfield: code plus raw UTF-8 value bytes.
type sub struct {
	code byte
	val  string
}

func dataField(tag, ind1, ind2 string, subs ...sub) encodedField {
	var body bytes.Buffer
	body.WriteString(ind1)
	body.WriteString(ind2)
	for _, s := range subs {
		body.WriteByte(sf)
		body.WriteByte(s.code)
		body.WriteString(s.val)
	}
	body.WriteByte(ft)
	return encodedField{tag: tag, body: body.Bytes()}
}

// encodeRecord builds a complete record from independently encoded fields.
// Directory order always follows fields; physicalOrder optionally permutes
// the physical data area while leaving the directory untouched.
func encodeRecord(t *testing.T, fields []encodedField, physicalOrder ...int) []byte {
	t.Helper()
	entryCount := len(fields)
	base := leaderLength + entryCount*dirEntryLength + 1

	physical := make([]encodedField, len(fields))
	if len(physicalOrder) == 0 {
		copy(physical, fields)
	} else {
		if len(physicalOrder) != len(fields) {
			t.Fatalf("physicalOrder has %d entries for %d fields", len(physicalOrder), len(fields))
		}
		seen := make([]bool, len(fields))
		for dirIndex, physicalIndex := range physicalOrder {
			if physicalIndex < 0 || physicalIndex >= len(fields) || seen[physicalIndex] {
				t.Fatalf("physicalOrder must be a permutation, got %v", physicalOrder)
			}
			seen[physicalIndex] = true
			physical[physicalIndex] = fields[dirIndex]
		}
	}

	data := make([]byte, 0)
	offsets := make([]int, len(fields))
	physicalIndexByDir := map[int]int{}
	for physicalIndex, f := range physical {
		physicalIndexByDir[dirIndexOf(fields, f)] = physicalIndex
	}
	running := 0
	physicalOffset := make([]int, len(physical))
	for i := range physical {
		physicalOffset[i] = running
		running += len(physical[i].body)
		data = append(data, physical[i].body...)
	}
	for dirIndex := range fields {
		offsets[dirIndex] = physicalOffset[physicalIndexByDir[dirIndex]]
	}

	var rec bytes.Buffer
	// Leader placeholders, then directory, then data + record terminator.
	// Positions: 00-04 length, 05 status, 06-09 "nam a", 10-11 "22",
	// 12-16 base, 17-19 three filler spaces, 20-23 "4500".
	leader := []byte("00000nam a2200000   4500")
	if len(leader) != leaderLength {
		t.Fatalf("leader fixture has %d bytes", len(leader))
	}
	total := base + len(data) + 1
	copy(leader[0:5], fmt.Sprintf("%05d", total))
	copy(leader[12:17], fmt.Sprintf("%05d", base))
	rec.Write(leader)

	for i, f := range fields {
		rec.WriteString(f.tag)
		rec.WriteString(fmt.Sprintf("%04d", len(f.body)))
		rec.WriteString(fmt.Sprintf("%05d", offsets[i]))
	}
	rec.WriteByte(ft)
	rec.Write(data)
	rec.WriteByte(rs)

	out := rec.Bytes()
	if len(out) != total {
		t.Fatalf("encoded length %d disagrees with declared %d", len(out), total)
	}
	return out
}

func dirIndexOf(fields []encodedField, target encodedField) int {
	for i, f := range fields {
		if f.tag == target.tag && bytes.Equal(f.body, target.body) {
			return i
		}
	}
	return -1
}

// chunkReader delivers src one byte per Read to prove arbitrary chunking.
type chunkReader struct {
	data []byte
	pos  int
}

func (c *chunkReader) Read(p []byte) (int, error) {
	if c.pos >= len(c.data) {
		return 0, io.EOF
	}
	p[0] = c.data[c.pos]
	c.pos++
	return 1, nil
}

func mustNext(t *testing.T, r *Reader) *Record {
	t.Helper()
	rec, err := r.Next()
	if err != nil {
		t.Fatalf("Next returned unexpected error: %v", err)
	}
	return rec
}

func valueAt(t *testing.T, rec *Record, br ByteRange) string {
	t.Helper()
	got, err := rec.Slice(br)
	if err != nil {
		t.Fatalf("Slice failed: %v", err)
	}
	return string(got)
}
