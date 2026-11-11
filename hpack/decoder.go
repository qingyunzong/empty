package hpack

import "errors"

var errNeedMore = errors.New("hpack: need more input")

// maxInteger bounds any prefix integer (indexes, lengths and table sizes) so a
// hostile stream cannot force unbounded growth through a long continuation.
const maxInteger = 1<<32 - 1

// Write feeds header block bytes into the Decoder. Complete representations are
// parsed immediately; bytes belonging to a representation split across writes
// stay buffered until a later Write. A compression error poisons the Decoder
// permanently and is returned on every subsequent call.
func (d *Decoder) Write(p []byte) (int, error) {
	if d.failed {
		return 0, d.err
	}
	if !d.inBlock {
		return 0, ErrNotInBlock
	}
	d.buf = append(d.buf, p...)
	for {
		start := d.off
		if start >= len(d.buf) {
			d.keepUnconsumed()
			return len(p), nil
		}
		err := d.parseOne()
		if err == nil {
			continue
		}
		if errors.Is(err, errNeedMore) {
			// Roll back any tentative consumption inside the partial
			// representation and keep the unconsumed prefix for the next write.
			d.off = start
			d.keepUnconsumed()
			return len(p), nil
		}
		d.fail(err)
		return 0, d.err
	}
}

// keepUnconsumed retains only the bytes from d.off onward, copying them into a
// fresh backing array so the next append cannot alias the old contents.
func (d *Decoder) keepUnconsumed() {
	remaining := len(d.buf) - d.off
	if remaining <= 0 {
		d.buf = d.buf[:0]
		d.off = 0
		return
	}
	next := make([]byte, remaining)
	copy(next, d.buf[d.off:])
	d.buf = next
	d.off = 0
}

// parseOne consumes a single representation starting at d.off. It returns
// errNeedMore when the representation spans into a not-yet-seen write.
func (d *Decoder) parseOne() error {
	if d.off >= len(d.buf) {
		return errNeedMore
	}
	first, err := d.peekByte()
	if err != nil {
		return err
	}
	switch {
	case first&0x80 != 0:
		// 1xxxxxxx: indexed header field (RFC 7541 section 6.1).
		return d.parseIndexed()
	case first&0xc0 == 0x40:
		// 01xxxxxx: literal with incremental indexing (section 6.2.1).
		return d.parseLiteral(true)
	case first&0xe0 == 0x20:
		// 001xxxxx: dynamic table size update (section 6.3).
		return d.parseTableSizeUpdate()
	default:
		// 0000xxxx (without indexing, section 6.2.2) and 0001xxxx (never
		// indexed, section 6.2.3) are decoded identically.
		return d.parseLiteral(false)
	}
}

func (d *Decoder) peekByte() (byte, error) {
	if d.off >= len(d.buf) {
		return 0, errNeedMore
	}
	return d.buf[d.off], nil
}

// parseIndexed handles the 1xxxxxxx indexed header field (RFC 7541 section
// 6.1).
func (d *Decoder) parseIndexed() error {
	index, err := d.readInt(7)
	if err != nil {
		return err
	}
	field, err := d.lookup(index)
	if err != nil {
		return err
	}
	d.leading = false
	d.emitted = append(d.emitted, HeaderField{Name: field.Name, Value: field.Value})
	return nil
}

// parseLiteral handles the literal header field forms. When indexed is true the
// form is 01xxxxxx (incremental indexing, section 6.2.1); otherwise it is
// 0000xxxx (without indexing, section 6.2.2) or 0001xxxx (never indexed,
// section 6.2.3). The two non-indexing forms are decoded identically.
func (d *Decoder) parseLiteral(indexed bool) error {
	prefix := uint8(4)
	if indexed {
		prefix = 6
	}
	index, err := d.readInt(prefix)
	if err != nil {
		return err
	}

	var name string
	if index == 0 {
		raw, err := d.readString()
		if err != nil {
			return err
		}
		name = string(raw)
	} else {
		field, err := d.lookup(index)
		if err != nil {
			return err
		}
		name = field.Name
	}

	rawValue, err := d.readString()
	if err != nil {
		return err
	}

	d.leading = false
	d.emitted = append(d.emitted, HeaderField{Name: name, Value: string(rawValue)})
	if indexed {
		d.addDynamic(name, string(rawValue))
	}
	return nil
}

// parseTableSizeUpdate handles 001xxxxx (section 6.3), which is legal only
// before any other representation in the header block.
func (d *Decoder) parseTableSizeUpdate() error {
	size, err := d.readInt(5)
	if err != nil {
		return err
	}
	if !d.leading {
		return compressionError("table size update", "dynamic table size update after start of header block")
	}
	if size > d.maxCap {
		return compressionError("table size update", "size %d exceeds connection limit %d", size, d.maxCap)
	}
	d.cap = size
	d.evictToFit()
	return nil
}

// lookup resolves a 1-based HPACK index across the static and dynamic tables.
func (d *Decoder) lookup(index int) (HeaderField, error) {
	if index <= 0 {
		return HeaderField{}, compressionError("index", "index 0 is not a valid indexed reference")
	}
	if index <= len(d.static) {
		return d.static[index-1], nil
	}
	dynIndex := index - len(d.static) - 1
	if dynIndex < len(d.dyn) {
		entry := d.dyn[dynIndex]
		return HeaderField{Name: entry.name, Value: entry.value}, nil
	}
	return HeaderField{}, compressionError("index", "index %d beyond static and dynamic tables", index)
}

// entrySize is the RFC 7541 entry size: name bytes + value bytes + 32.
func entrySize(name, value string) int {
	return len(name) + len(value) + 32
}

// addDynamic inserts an incremental-indexing entry, evicting older entries as
// required. An entry larger than the current capacity empties the table and is
// never inserted (RFC 7541 section 4.4).
func (d *Decoder) addDynamic(name, value string) {
	entry := dynamicEntry{name: name, value: value, size: entrySize(name, value)}
	if entry.size > d.cap {
		d.dyn = nil
		d.size = 0
		return
	}
	d.dyn = append(d.dyn, dynamicEntry{})
	copy(d.dyn[1:], d.dyn)
	d.dyn[0] = entry
	d.size += entry.size
	d.evictToFit()
}

// evictToFit drops oldest entries (the tail of the newest-first slice) until
// the table fits its current capacity.
func (d *Decoder) evictToFit() {
	for d.size > d.cap && len(d.dyn) > 0 {
		oldest := d.dyn[len(d.dyn)-1]
		d.size -= oldest.size
		d.dyn = d.dyn[:len(d.dyn)-1]
	}
}

// readInt decodes an RFC 7541 section 5.1 prefix integer. n is the prefix
// width in bits (5, 6 or 7).
func (d *Decoder) readInt(n uint8) (int, error) {
	if d.off >= len(d.buf) {
		return 0, errNeedMore
	}
	mask := byte((1 << n) - 1)
	prefix := d.buf[d.off] & mask
	d.off++
	if int(prefix) < int(mask) {
		return int(prefix), nil
	}

	value := uint64(mask)
	var shift uint
	for {
		if d.off >= len(d.buf) {
			return 0, errNeedMore
		}
		b := d.buf[d.off]
		d.off++
		chunk := uint64(b & 0x7f)
		if shift >= 63 || chunk<<shift>>shift != chunk {
			return 0, compressionError("integer", "prefix integer overflow")
		}
		value += chunk << shift
		if value > maxInteger {
			return 0, compressionError("integer", "prefix integer exceeds %d", maxInteger)
		}
		if b&0x80 == 0 {
			return int(value), nil
		}
		shift += 7
	}
}

// readString decodes one literal string (section 5.2), transparently applying
// Huffman decoding when the H bit is set. The returned bytes are copied out of
// the streaming buffer so they remain valid after later writes.
func (d *Decoder) readString() ([]byte, error) {
	if d.off >= len(d.buf) {
		return nil, errNeedMore
	}
	huffman := d.buf[d.off]&0x80 != 0
	length, err := d.readInt(7)
	if err != nil {
		return nil, err
	}
	if d.off+length > len(d.buf) {
		return nil, errNeedMore
	}
	raw := make([]byte, length)
	copy(raw, d.buf[d.off:d.off+length])
	d.off += length

	if !huffman {
		return raw, nil
	}
	out, err := d.huff.decode(raw)
	if err != nil {
		return nil, &CompressionError{Op: "huffman", Err: err}
	}
	return out, nil
}
