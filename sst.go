package dataeng

import (
	"encoding/binary"
	"fmt"
	"strings"
)

// FragmentType identifies the BIFF record from which a payload fragment came.
// An SST record must be first; every following fragment must be a CONTINUE
// record.
type FragmentType uint8

const (
	FragmentSST      FragmentType = iota // SST record payload
	FragmentContinue                     // CONTINUE record payload
)

// Fragment is a single non-empty BIFF record payload. Data is not modified by
// ReadSST.
type Fragment struct {
	Type FragmentType
	Data []byte
}

// NewSSTFragment wraps the first payload read from an SST BIFF record.
func NewSSTFragment(data []byte) Fragment {
	return Fragment{Type: FragmentSST, Data: data}
}

// NewContinueFragment wraps a payload read from a CONTINUE BIFF record.
func NewContinueFragment(data []byte) Fragment {
	return Fragment{Type: FragmentContinue, Data: data}
}

// Unit is one decoded UTF-16 unit together with its original source. Fragment
// is the index in the fragment slice supplied to ReadSST, Offset is the byte
// offset in that fragment's Data, and Size is 1 or 2 bytes. A high/low
// surrogate pair therefore has two Unit entries and may point at two
// different fragments.
type Unit struct {
	Value    uint16
	Fragment int
	Offset   int
	Size     int
}

// Run is one rich-text formatting run. Start is a UTF-16 unit index and Font
// is the font identifier stored in the SST record.
type Run struct {
	Start uint16
	Font  uint16
}

// SSTString is one shared string. Ext is the uninterpreted extended data
// declared by flags bit 2.
type SSTString struct {
	Text  string
	Units []Unit
	Runs  []Run
	Ext   []byte
}

// Table is the complete result of decoding all unique strings in an SST
// payload. TotalReferences is the reference count from the SST header; it is
// deliberately not used as the number of strings to decode.
type Table struct {
	TotalReferences uint32
	UniqueCount     uint32
	Strings         []SSTString
}

// ReadSST decodes the unique strings in an SST record and its CONTINUE
// records. It never concatenates the payloads: a continuation fragment's
// leading byte is consumed as a character-width marker only while a string
// still has character units to read. On error no partial table is returned.
func ReadSST(fragments []Fragment) (*Table, error) {
	if len(fragments) == 0 {
		return nil, fmt.Errorf("sst: no payload fragments")
	}
	for i := range fragments {
		if len(fragments[i].Data) == 0 {
			return nil, fmt.Errorf("sst: fragment %d is empty", i)
		}
		if i == 0 {
			if fragments[i].Type != FragmentSST {
				return nil, fmt.Errorf("sst: fragment 0 has type %d, want SST", fragments[i].Type)
			}
		} else if fragments[i].Type != FragmentContinue {
			return nil, fmt.Errorf("sst: fragment %d has type %d, want CONTINUE", i, fragments[i].Type)
		}
	}

	first := fragments[0].Data
	if len(first) < 8 {
		return nil, fmt.Errorf("sst: first fragment has %d bytes, want at least 8", len(first))
	}
	total := binary.LittleEndian.Uint32(first[0:4])
	unique := binary.LittleEndian.Uint32(first[4:8])
	if total < unique {
		return nil, fmt.Errorf("sst: total references %d is less than unique strings %d", total, unique)
	}
	if uint64(total) > uint64(maxHostInt()) || uint64(unique) > uint64(maxHostInt()) {
		return nil, fmt.Errorf("sst: declared counts exceed host integer limit (total=%d unique=%d)", total, unique)
	}

	c := &cursor{fragments: fragments, fragment: 0, offset: 8}
	remaining := c.remaining()
	// Every string needs at least its 2-byte cch and 1-byte flags. Refuse an
	// impossible declaration before allocating a result sized by it.
	if int64(unique) > remaining/3 {
		return nil, fmt.Errorf("sst: unique string count %d cannot fit in %d remaining payload bytes", unique, remaining)
	}

	table := &Table{
		TotalReferences: total,
		UniqueCount:     unique,
		Strings:         make([]SSTString, 0, int(unique)),
	}
	for i := 0; i < int(unique); i++ {
		s, err := readString(c, i)
		if err != nil {
			return nil, fmt.Errorf("sst: string %d: %w", i, err)
		}
		table.Strings = append(table.Strings, s)
	}

	if left := c.remaining(); left != 0 {
		return nil, fmt.Errorf("sst: %d payload bytes remain after %d unique strings", left, unique)
	}
	return table, nil
}

type sstStringHeader struct {
	cch   int
	flags byte
	cRun  int
	cbExt int
}

func readString(c *cursor, index int) (SSTString, error) {
	h, err := readStringHeader(c, index)
	if err != nil {
		return SSTString{}, err
	}
	if h.cRun > 0 && h.cch == 0 {
		return SSTString{}, fmt.Errorf("rich-text run count %d requires cch > 0", h.cRun)
	}

	units, err := readCharacters(c, h.cch, h.flags)
	if err != nil {
		return SSTString{}, err
	}
	text, err := buildText(units)
	if err != nil {
		return SSTString{}, err
	}
	runs, err := readRuns(c, h.cRun, h.cch)
	if err != nil {
		return SSTString{}, err
	}
	if err := validateRuns(runs, units, h.cch); err != nil {
		return SSTString{}, err
	}
	ext, err := readExt(c, h.cbExt)
	if err != nil {
		return SSTString{}, err
	}
	return SSTString{Text: text, Units: units, Runs: runs, Ext: ext}, nil
}

func readStringHeader(c *cursor, index int) (sstStringHeader, error) {
	if err := c.ensureFragment(); err != nil {
		return sstStringHeader{}, fmt.Errorf("string %d header: %w", index, err)
	}
	at := c.fragment
	d := c.fragments[at].Data
	remaining := len(d) - c.offset
	if remaining < 3 {
		return sstStringHeader{}, fmt.Errorf("fixed header spans fragment %d boundary (%d bytes left)", at, remaining)
	}

	cch := int(binary.LittleEndian.Uint16(d[c.offset : c.offset+2]))
	flags := d[c.offset+2]
	if flags&^byte(0x0D) != 0 {
		return sstStringHeader{}, fmt.Errorf("flags 0x%02x set an unsupported bit", flags)
	}

	need := 3
	if flags&0x08 != 0 {
		need += 2
	}
	if flags&0x04 != 0 {
		need += 4
	}
	if remaining < need {
		return sstStringHeader{}, fmt.Errorf("fixed header spans fragment %d boundary (%d of %d bytes left)", at, remaining, need)
	}

	h := sstStringHeader{cch: cch, flags: flags}
	p := c.offset + 3
	if flags&0x08 != 0 {
		h.cRun = int(binary.LittleEndian.Uint16(d[p : p+2]))
		p += 2
	}
	if flags&0x04 != 0 {
		raw := binary.LittleEndian.Uint32(d[p : p+4])
		signed := int32(raw)
		if signed < 0 {
			return sstStringHeader{}, fmt.Errorf("negative extended-tail length %d", signed)
		}
		h.cbExt = int(signed)
		p += 4
	}

	c.offset += need
	return h, nil
}

func readCharacters(c *cursor, cch int, flags byte) ([]Unit, error) {
	if cch == 0 {
		return nil, nil
	}
	if int64(cch) > c.remaining() {
		return nil, fmt.Errorf("character count %d exceeds remaining payload %d", cch, c.remaining())
	}
	if !fitsHost(int64(cch), 1) {
		return nil, fmt.Errorf("character count %d exceeds host limits", cch)
	}

	units := make([]Unit, cch)
	doubleByte := flags&0x01 != 0
	for i := 0; i < cch; i++ {
		if c.fragment >= len(c.fragments) {
			return nil, fmt.Errorf("character data ended before %d units were read", cch)
		}
		d := c.fragments[c.fragment].Data
		if c.offset == len(d) {
			c.fragment++
			c.offset = 0
			if c.fragment >= len(c.fragments) {
				return nil, fmt.Errorf("character data ended before %d units were read", cch)
			}
			d = c.fragments[c.fragment].Data
			marker := d[0]
			if marker > 1 {
				return nil, fmt.Errorf("character continuation in fragment %d starts with 0x%02x, want 0 or 1", c.fragment, marker)
			}
			doubleByte = marker == 1
			c.offset = 1
			if c.offset == len(d) {
				return nil, fmt.Errorf("character continuation in fragment %d contains only a width marker", c.fragment)
			}
		}

		d = c.fragments[c.fragment].Data
		offset := c.offset
		if doubleByte {
			if len(d)-offset < 2 {
				return nil, fmt.Errorf("two-byte UTF-16 unit is truncated at fragment %d boundary", c.fragment)
			}
			units[i] = Unit{
				Value:    binary.LittleEndian.Uint16(d[offset : offset+2]),
				Fragment: c.fragment,
				Offset:   offset,
				Size:     2,
			}
			c.offset += 2
		} else {
			units[i] = Unit{
				Value:    uint16(d[offset]),
				Fragment: c.fragment,
				Offset:   offset,
				Size:     1,
			}
			c.offset++
		}
	}
	return units, nil
}

func buildText(units []Unit) (string, error) {
	if len(units) == 0 {
		return "", nil
	}
	var b strings.Builder
	b.Grow(len(units))
	for i := 0; i < len(units); i++ {
		v := units[i].Value
		switch {
		case v >= 0xD800 && v <= 0xDBFF:
			if i+1 >= len(units) {
				return "", fmt.Errorf("unpaired high surrogate U+%04X at UTF-16 unit %d", v, i)
			}
			low := units[i+1].Value
			if low < 0xDC00 || low > 0xDFFF {
				return "", fmt.Errorf("high surrogate U+%04X at UTF-16 unit %d is followed by U+%04X", v, i, low)
			}
			r := rune(0x10000 + (int32(v)-0xD800)*0x400 + (int32(low) - 0xDC00))
			b.WriteRune(r)
			i++
		case v >= 0xDC00 && v <= 0xDFFF:
			return "", fmt.Errorf("unpaired low surrogate U+%04X at UTF-16 unit %d", v, i)
		default:
			b.WriteRune(rune(v))
		}
	}
	return b.String(), nil
}

func readRuns(c *cursor, cRun int, cch int) ([]Run, error) {
	if cRun == 0 {
		return nil, nil
	}
	byteCount := int64(cRun) * 4
	if !fitsHost(byteCount, 1) || byteCount > c.remaining() {
		return nil, fmt.Errorf("declared run count %d needs %d bytes, only %d remain", cRun, byteCount, c.remaining())
	}
	runs := make([]Run, cRun)
	for i := 0; i < cRun; i++ {
		raw, err := c.readAcross(4)
		if err != nil {
			return nil, fmt.Errorf("run %d: %w", i, err)
		}
		runs[i] = Run{
			Start: binary.LittleEndian.Uint16(raw[0:2]),
			Font:  binary.LittleEndian.Uint16(raw[2:4]),
		}
	}
	return runs, nil
}

func validateRuns(runs []Run, units []Unit, cch int) error {
	if len(runs) == 0 {
		return nil
	}
	if cch == 0 {
		return fmt.Errorf("rich-text runs require cch > 0")
	}
	if len(runs) > cch {
		return fmt.Errorf("run count %d exceeds cch %d", len(runs), cch)
	}
	if runs[0].Start != 0 {
		return fmt.Errorf("first run starts at UTF-16 unit %d, want 0", runs[0].Start)
	}
	for i, r := range runs {
		pos := int(r.Start)
		if pos >= cch {
			return fmt.Errorf("run %d starts at UTF-16 unit %d, want less than cch %d", i, pos, cch)
		}
		if i > 0 && pos <= int(runs[i-1].Start) {
			return fmt.Errorf("run positions must strictly increase (run %d starts at %d)", i, pos)
		}
		if pos > 0 && isLowSurrogate(units[pos].Value) {
			return fmt.Errorf("run %d starts inside a surrogate pair at UTF-16 unit %d", i, pos)
		}
	}
	return nil
}

func readExt(c *cursor, cbExt int) ([]byte, error) {
	if cbExt == 0 {
		return nil, nil
	}
	if !fitsHost(int64(cbExt), 1) || int64(cbExt) > c.remaining() {
		return nil, fmt.Errorf("extended tail length %d exceeds remaining payload %d", cbExt, c.remaining())
	}
	ext := make([]byte, cbExt)
	if err := c.copyAcross(ext); err != nil {
		return nil, fmt.Errorf("extended tail: %w", err)
	}
	return ext, nil
}

func isLowSurrogate(v uint16) bool {
	return v >= 0xDC00 && v <= 0xDFFF
}

type cursor struct {
	fragments []Fragment
	fragment  int
	offset    int
}

func (c *cursor) remaining() int64 {
	if c.fragment >= len(c.fragments) {
		return 0
	}
	n := int64(len(c.fragments[c.fragment].Data) - c.offset)
	for i := c.fragment + 1; i < len(c.fragments); i++ {
		n += int64(len(c.fragments[i].Data))
	}
	return n
}

// ensureFragment crosses a completely consumed fragment without consuming any
// width marker. It is used when a header, run, or extended tail may begin in
// the next fragment.
func (c *cursor) ensureFragment() error {
	if c.fragment >= len(c.fragments) {
		return fmt.Errorf("unexpected end of payload")
	}
	if c.offset == len(c.fragments[c.fragment].Data) {
		c.fragment++
		c.offset = 0
		if c.fragment >= len(c.fragments) {
			return fmt.Errorf("unexpected end of payload")
		}
	}
	return nil
}

func (c *cursor) readAcross(n int) ([]byte, error) {
	if n < 0 || int64(n) > c.remaining() {
		return nil, fmt.Errorf("need %d bytes, only %d remain", n, c.remaining())
	}
	buf := make([]byte, n)
	if err := c.copyAcross(buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func (c *cursor) copyAcross(dst []byte) error {
	for len(dst) > 0 {
		if c.fragment >= len(c.fragments) {
			return fmt.Errorf("unexpected end of payload")
		}
		d := c.fragments[c.fragment].Data
		if c.offset == len(d) {
			c.fragment++
			c.offset = 0
			continue
		}
		n := len(d) - c.offset
		if n > len(dst) {
			n = len(dst)
		}
		copy(dst[:n], d[c.offset:c.offset+n])
		c.offset += n
		dst = dst[n:]
	}
	return nil
}

func maxHostInt() int {
	return int(^uint(0) >> 1)
}

// fitsHost reports whether count elements of elemSize bytes can be allocated
// by this host without overflow.
func fitsHost(count int64, elemSize int) bool {
	if count < 0 || elemSize <= 0 {
		return false
	}
	limit := int64(maxHostInt()) / int64(elemSize)
	return count <= limit
}
