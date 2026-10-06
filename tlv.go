// Package tlv parses and re-encodes BER-style TLV (Tag-Length-Value) data.
//
// The parser accepts short-form and long-form definite lengths as well as
// indefinite-length constructed values terminated by an end-of-contents
// marker. It rejects non-minimal length encodings, nesting deeper than a
// configurable limit, and child items that extend past their parent's
// content boundary. Indefinite length is permitted on constructed items
// only.
package tlv

import "fmt"

// Kind classifies a parse Error.
type Kind int

const (
	// KindTruncated means the input ended before the current item was
	// complete. Offset is the position where more bytes were needed,
	// i.e. len(input) for a truncated prefix.
	KindTruncated Kind = iota
	// KindNonMinimalLength means a long-form length was used where the
	// short form suffices, or the length had superfluous leading zeros.
	KindNonMinimalLength
	// KindIndefinitePrimitive means an indefinite length was used on a
	// primitive (non-constructed) item.
	KindIndefinitePrimitive
	// KindReservedLength means the reserved length octet 0xFF was used.
	KindReservedLength
	// KindLengthTooLarge means the length-of-length exceeds 8 bytes or
	// the length value overflows int.
	KindLengthTooLarge
	// KindInvalidTag means the identifier octets were malformed.
	KindInvalidTag
	// KindDepthExceeded means constructed nesting exceeded the limit.
	KindDepthExceeded
	// KindBoundary means a child item extends past the end of its
	// parent's content.
	KindBoundary
	// KindUnexpectedEOC means an end-of-contents marker appeared outside
	// an indefinite-length constructed value.
	KindUnexpectedEOC
	// KindTrailingData means extra bytes follow the top-level item.
	KindTrailingData
)

// Error describes a parse failure at a byte offset in the input.
type Error struct {
	Kind   Kind
	Offset int
	msg    string
}

func (e *Error) Error() string {
	return fmt.Sprintf("tlv: offset %d: %s", e.Offset, e.msg)
}

// DefaultMaxDepth is the nesting limit used by Parse.
const DefaultMaxDepth = 64

// Node is a parsed TLV item. Constructed items hold Children; primitive
// items hold Value.
type Node struct {
	Class       byte   // 0 universal, 1 application, 2 context-specific, 3 private
	Constructed bool   // bit 6 of the first identifier octet
	Tag         uint64 // tag number
	Indefinite  bool   // encoded with indefinite length (constructed only)
	Value       []byte // content octets of a primitive item
	Children    []*Node

	id []byte // raw identifier octets, kept for exact re-encoding
}

// Parse decodes a single top-level TLV item from data, which it must
// consume exactly, using DefaultMaxDepth.
func Parse(data []byte) (*Node, error) {
	return ParseDepth(data, DefaultMaxDepth)
}

// ParseDepth is Parse with an explicit nesting-depth limit. Depth 0 is the
// top-level item; its children are at depth 1, and so on.
func ParseDepth(data []byte, maxDepth int) (*Node, error) {
	n, next, err := parseNode(data, 0, len(data), 0, maxDepth)
	if err != nil {
		return nil, err
	}
	if next != len(data) {
		return nil, &Error{Kind: KindTrailingData, Offset: next, msg: "trailing data after top-level item"}
	}
	return n, nil
}

// parseNode parses one item starting at off. Reads are bounded by limit,
// which is the end of the enclosing parent's content (or len(data) at the
// top level). It returns the node and the offset just past the item.
func parseNode(data []byte, off, limit, depth, maxDepth int) (*Node, int, error) {
	if depth > maxDepth {
		return nil, 0, &Error{Kind: KindDepthExceeded, Offset: off, msg: "nesting depth exceeds limit"}
	}
	start := off
	fail := func() (*Node, int, error) {
		if limit == len(data) {
			return nil, 0, &Error{Kind: KindTruncated, Offset: limit, msg: "unexpected end of data"}
		}
		return nil, 0, &Error{Kind: KindBoundary, Offset: start, msg: "item crosses parent content boundary"}
	}
	readByte := func(pos int) (byte, bool) {
		if pos >= limit {
			return 0, false
		}
		return data[pos], true
	}

	// Identifier octets.
	b, ok := readByte(off)
	if !ok {
		return fail()
	}
	off++
	n := &Node{
		Class:       b >> 6,
		Constructed: b&0x20 != 0,
		Tag:         uint64(b & 0x1F),
	}
	n.id = append(n.id, b)
	if b&0x1F == 0x1F { // high-tag-number form
		n.Tag = 0
		for {
			tb, ok := readByte(off)
			if !ok {
				return fail()
			}
			off++
			n.id = append(n.id, tb)
			if n.Tag > 1<<57 {
				return nil, 0, &Error{Kind: KindInvalidTag, Offset: start, msg: "tag number too large"}
			}
			n.Tag = n.Tag<<7 | uint64(tb&0x7F)
			if tb&0x80 == 0 {
				break
			}
		}
	}

	// Length octets.
	lenOff := off
	lb, ok := readByte(off)
	if !ok {
		return fail()
	}
	off++
	indefinite := false
	length := 0
	switch {
	case lb < 0x80: // short form
		length = int(lb)
	case lb == 0x80: // indefinite form
		if !n.Constructed {
			return nil, 0, &Error{Kind: KindIndefinitePrimitive, Offset: lenOff, msg: "indefinite length on primitive item"}
		}
		indefinite = true
	case lb == 0xFF:
		return nil, 0, &Error{Kind: KindReservedLength, Offset: lenOff, msg: "reserved length octet 0xFF"}
	default: // long form
		num := int(lb & 0x7F)
		if num > 8 {
			return nil, 0, &Error{Kind: KindLengthTooLarge, Offset: lenOff, msg: "length-of-length exceeds 8 bytes"}
		}
		if off+num > limit {
			return fail()
		}
		if data[off] == 0 {
			return nil, 0, &Error{Kind: KindNonMinimalLength, Offset: lenOff, msg: "length has leading zero octet"}
		}
		var l uint64
		for i := 0; i < num; i++ {
			l = l<<8 | uint64(data[off+i])
		}
		off += num
		if l > uint64(int(^uint(0)>>1)) {
			return nil, 0, &Error{Kind: KindLengthTooLarge, Offset: lenOff, msg: "length overflows int"}
		}
		if l < 128 {
			return nil, 0, &Error{Kind: KindNonMinimalLength, Offset: lenOff, msg: "long form used for length below 128"}
		}
		length = int(l)
	}

	// End-of-contents marker is only valid as a terminator, handled by
	// the indefinite-length loop below.
	if len(n.id) == 1 && n.id[0] == 0x00 && !indefinite && length == 0 {
		return nil, 0, &Error{Kind: KindUnexpectedEOC, Offset: start, msg: "end-of-contents outside indefinite-length item"}
	}

	if indefinite {
		n.Indefinite = true
		for {
			if off >= limit {
				return fail()
			}
			if data[off] == 0x00 {
				if _, ok := readByte(off + 1); !ok {
					return fail()
				}
				if data[off+1] == 0x00 {
					off += 2
					return n, off, nil
				}
			}
			child, next, err := parseNode(data, off, limit, depth+1, maxDepth)
			if err != nil {
				return nil, 0, err
			}
			n.Children = append(n.Children, child)
			off = next
		}
	}

	end := off + length
	if end > limit {
		return fail()
	}
	if n.Constructed {
		for off < end {
			child, next, err := parseNode(data, off, end, depth+1, maxDepth)
			if err != nil {
				return nil, 0, err
			}
			n.Children = append(n.Children, child)
			off = next
		}
	} else {
		n.Value = data[off:end]
	}
	return n, end, nil
}

// Encode re-encodes the item. Definite lengths are emitted in their
// minimal form, so encoding a parsed node reproduces the original bytes.
func (n *Node) Encode() []byte {
	out := append([]byte(nil), n.id...)
	if n.Indefinite {
		out = append(out, 0x80)
		for _, c := range n.Children {
			out = append(out, c.Encode()...)
		}
		return append(out, 0x00, 0x00)
	}
	var content []byte
	if n.Constructed {
		for _, c := range n.Children {
			content = append(content, c.Encode()...)
		}
	} else {
		content = n.Value
	}
	out = appendLength(out, len(content))
	return append(out, content...)
}

func appendLength(out []byte, l int) []byte {
	if l < 128 {
		return append(out, byte(l))
	}
	var tmp [8]byte
	i := len(tmp)
	for l > 0 {
		i--
		tmp[i] = byte(l)
		l >>= 8
	}
	out = append(out, 0x80|byte(len(tmp)-i))
	return append(out, tmp[i:]...)
}
