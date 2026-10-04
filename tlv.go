// Package tlv parses and encodes BER-style Tag-Length-Value data.
//
// Wire format: a one-octet tag (class bits 7-6, constructed flag bit 5,
// tag number bits 4-0), a length in short form (0x00-0x7F), long form
// (0x81-0x84 followed by 1-4 big-endian length octets), or indefinite
// form (0x80, constructed values only, terminated by an end-of-contents
// marker 0x00 0x00). Non-minimal length encodings are rejected.
package tlv

import "fmt"

const (
	ClassUniversal   byte = 0x00
	ClassApplication byte = 0x40
	ClassContext     byte = 0x80
	ClassPrivate     byte = 0xC0

	// ConstructedFlag marks a tag whose content is a sequence of child TLVs.
	ConstructedFlag byte = 0x20

	tagMask byte = 0x1F
)

const (
	// MaxDepth is the maximum nesting depth of constructed values.
	MaxDepth = 32
	// maxLenBytes caps the long-form length-of-length.
	maxLenBytes = 4
)

// Error describes a parse failure at a byte offset in the input.
type Error struct {
	Offset int
	Msg    string
}

func (e *Error) Error() string {
	return fmt.Sprintf("tlv: offset %d: %s", e.Offset, e.Msg)
}

// Node is a parsed TLV value. Constructed nodes hold Children; primitive
// nodes hold Value. Indefinite records whether the node was encoded with
// indefinite length so Encode reproduces the input byte-for-byte.
type Node struct {
	Class       byte
	Tag         byte
	Constructed bool
	Indefinite  bool
	Value       []byte
	Children    []*Node
}

// Parse reads exactly one TLV value from data. Trailing bytes are an error.
func Parse(data []byte) (*Node, error) {
	p := &parser{data: data}
	n, err := p.node(len(data), 0)
	if err != nil {
		return nil, err
	}
	if p.pos != len(data) {
		return nil, &Error{Offset: p.pos, Msg: "trailing bytes after top-level value"}
	}
	return n, nil
}

type parser struct {
	data []byte
	pos  int
}

func (p *parser) node(end, depth int) (*Node, error) {
	if depth > MaxDepth {
		return nil, &Error{Offset: p.pos, Msg: "nesting depth exceeds limit"}
	}
	start := p.pos
	if end-p.pos < 2 {
		return nil, &Error{Offset: p.pos, Msg: "truncated header"}
	}
	tagByte := p.data[p.pos]
	p.pos++
	if tagByte == 0x00 {
		return nil, &Error{Offset: start, Msg: "end-of-contents marker outside indefinite-length value"}
	}
	n := &Node{
		Class:       tagByte & 0xC0,
		Tag:         tagByte & tagMask,
		Constructed: tagByte&ConstructedFlag != 0,
	}

	lenByte := p.data[p.pos]
	p.pos++
	contentEnd := 0
	switch {
	case lenByte < 0x80:
		contentEnd = p.pos + int(lenByte)
	case lenByte == 0x80:
		if !n.Constructed {
			return nil, &Error{Offset: p.pos - 1, Msg: "indefinite length on primitive value"}
		}
		n.Indefinite = true
	default:
		num := int(lenByte & 0x7F)
		if num == 0x7F {
			return nil, &Error{Offset: p.pos - 1, Msg: "reserved length-of-length 0xFF"}
		}
		if num > maxLenBytes {
			return nil, &Error{Offset: p.pos - 1, Msg: "length-of-length exceeds 4 bytes"}
		}
		if end-p.pos < num {
			return nil, &Error{Offset: p.pos, Msg: "truncated long-form length"}
		}
		if p.data[p.pos] == 0x00 {
			return nil, &Error{Offset: p.pos, Msg: "non-minimal length: leading zero byte"}
		}
		lengthStart := p.pos
		length := 0
		for i := 0; i < num; i++ {
			length = length<<8 | int(p.data[p.pos])
			p.pos++
		}
		if length < 0x80 {
			return nil, &Error{Offset: lengthStart, Msg: "non-minimal length: long form for value below 128"}
		}
		contentEnd = p.pos + length
	}

	if n.Indefinite {
		for {
			if end-p.pos < 2 {
				return nil, &Error{Offset: p.pos, Msg: "unterminated indefinite-length value"}
			}
			if p.data[p.pos] == 0x00 && p.data[p.pos+1] == 0x00 {
				p.pos += 2
				return n, nil
			}
			child, err := p.node(end, depth+1)
			if err != nil {
				return nil, err
			}
			n.Children = append(n.Children, child)
		}
	}

	if contentEnd > end {
		return nil, &Error{Offset: start, Msg: "content extends beyond enclosing value"}
	}
	if n.Constructed {
		for p.pos < contentEnd {
			child, err := p.node(contentEnd, depth+1)
			if err != nil {
				return nil, err
			}
			n.Children = append(n.Children, child)
		}
	} else {
		n.Value = append([]byte(nil), p.data[p.pos:contentEnd]...)
		p.pos = contentEnd
	}
	return n, nil
}

// Encode serializes the node back to its wire form. For a node produced by
// Parse, Encode returns the original input bytes.
func (n *Node) Encode() []byte {
	out := make([]byte, 0, 16)
	return n.appendTo(out)
}

func (n *Node) appendTo(out []byte) []byte {
	tagByte := n.Class | n.Tag
	if n.Constructed {
		tagByte |= ConstructedFlag
	}
	out = append(out, tagByte)
	if n.Constructed {
		if n.Indefinite {
			out = append(out, 0x80)
			for _, c := range n.Children {
				out = c.appendTo(out)
			}
			return append(out, 0x00, 0x00)
		}
		body := make([]byte, 0, 16)
		for _, c := range n.Children {
			body = c.appendTo(body)
		}
		out = appendLength(out, len(body))
		return append(out, body...)
	}
	out = appendLength(out, len(n.Value))
	return append(out, n.Value...)
}

func appendLength(out []byte, length int) []byte {
	if length < 0x80 {
		return append(out, byte(length))
	}
	var buf [maxLenBytes]byte
	i := len(buf)
	for l := length; l > 0; l >>= 8 {
		i--
		buf[i] = byte(l)
	}
	out = append(out, 0x80|byte(len(buf)-i))
	return append(out, buf[i:]...)
}
