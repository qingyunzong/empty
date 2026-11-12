package dataeng

import (
	"bytes"
)

// Encode re-serializes the tree with minimal whitespace. Key order, duplicate
// keys, and the original number lexemes are preserved byte-for-byte at the
// value level.
func Encode(root *Node) ([]byte, error) {
	var buf bytes.Buffer
	if err := encodeNode(&buf, root); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// EncodeIndented re-serializes the tree with the given indent prefix. Each
// nesting level adds one indent unit; number lexemes and key order remain
// identical to Encode, only whitespace changes.
func EncodeIndented(root *Node, indent string) ([]byte, error) {
	var buf bytes.Buffer
	if err := encodeNodeIndented(&buf, root, "", indent); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func encodeNode(buf *bytes.Buffer, n *Node) error {
	if n == nil {
		return ErrSyntax
	}
	switch n.Kind {
	case KindObject:
		buf.WriteByte('{')
		for i, member := range n.Members {
			if i > 0 {
				buf.WriteByte(',')
			}
			encodeString(buf, member.Key)
			buf.WriteByte(':')
			if err := encodeNode(buf, member.Value); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	case KindArray:
		buf.WriteByte('[')
		for i, elem := range n.Elems {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := encodeNode(buf, elem); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case KindString:
		encodeString(buf, n.Str)
	case KindNumber:
		buf.WriteString(n.Num.Lexeme())
	case KindBool:
		if n.Bool {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case KindNull:
		buf.WriteString("null")
	default:
		return ErrSyntax
	}
	return nil
}

func encodeNodeIndented(buf *bytes.Buffer, n *Node, pad, unit string) error {
	if n == nil {
		return ErrSyntax
	}
	switch n.Kind {
	case KindObject:
		if len(n.Members) == 0 {
			buf.WriteString("{}")
			return nil
		}
		buf.WriteString("{\n")
		childPad := pad + unit
		for i, member := range n.Members {
			buf.WriteString(childPad)
			encodeString(buf, member.Key)
			buf.WriteString(": ")
			if err := encodeNodeIndented(buf, member.Value, childPad, unit); err != nil {
				return err
			}
			if i < len(n.Members)-1 {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		buf.WriteString(pad)
		buf.WriteByte('}')
	case KindArray:
		if len(n.Elems) == 0 {
			buf.WriteString("[]")
			return nil
		}
		buf.WriteString("[\n")
		childPad := pad + unit
		for i, elem := range n.Elems {
			buf.WriteString(childPad)
			if err := encodeNodeIndented(buf, elem, childPad, unit); err != nil {
				return err
			}
			if i < len(n.Elems)-1 {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		buf.WriteString(pad)
		buf.WriteByte(']')
	default:
		return encodeNode(buf, n)
	}
	return nil
}

// encodeString emits strict JSON: the decoded string was validated as UTF-8,
// so quoting only escapes required control characters and the mandatory
// quote/backslash.
func encodeString(buf *bytes.Buffer, s string) {
	buf.WriteByte('"')
	start := 0
	for i := 0; i < len(s); {
		b := s[i]
		if b < 0x20 || b == '"' || b == '\\' {
			buf.WriteString(s[start:i])
			switch b {
			case '"', '\\':
				buf.WriteByte('\\')
				buf.WriteByte(b)
			case '\n':
				buf.WriteString(`\n`)
			case '\r':
				buf.WriteString(`\r`)
			case '\t':
				buf.WriteString(`\t`)
			case '\b':
				buf.WriteString(`\b`)
			case '\f':
				buf.WriteString(`\f`)
			default:
				buf.WriteString(`\u00`)
				h := "0123456789abcdef"
				buf.WriteByte(h[b>>4])
				buf.WriteByte(h[b&0x0f])
			}
			i++
			start = i
			continue
		}
		i++
	}
	buf.WriteString(s[start:])
	buf.WriteByte('"')
}
