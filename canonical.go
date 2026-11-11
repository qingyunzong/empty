package q213

import (
	"bytes"
	"cmp"
	"slices"
)

// Canonical renders a node to the binary canonical form:
//
//   - element: "E", expanded name, 32-bit big-endian attribute count, then
//     each attribute as expanded name followed by a 32-bit big-endian length
//     prefixed UTF-8 value, then canonicalized children, then "Z";
//   - text: "T" followed by a 32-bit big-endian length prefixed UTF-8 value.
//
// An expanded name is two length-prefixed strings: the namespace URI and
// then the local name. Namespace prefixes never appear in the stream, so
// prefix changes cannot alter the signature input.
func Canonical(node *Node) []byte {
	var buf bytes.Buffer
	canonicalNode(&buf, node)
	return buf.Bytes()
}

func canonicalNode(buf *bytes.Buffer, node *Node) {
	if !node.IsElement() {
		buf.WriteByte('T')
		writeLengthString(buf, node.Text)
		return
	}

	buf.WriteByte('E')
	writeExpandedName(buf, node.Namespace, node.Local)
	writeUint32(buf, uint32(len(node.Attrs)))
	for i := range node.Attrs {
		writeExpandedName(buf, node.Attrs[i].Namespace, node.Attrs[i].Local)
		writeLengthString(buf, node.Attrs[i].Value)
	}
	for _, child := range node.Children {
		canonicalNode(buf, child)
	}
	buf.WriteByte('Z')
}

func writeExpandedName(buf *bytes.Buffer, namespace, local string) {
	writeLengthString(buf, namespace)
	writeLengthString(buf, local)
}

func writeLengthString(buf *bytes.Buffer, value string) {
	writeUint32(buf, uint32(len(value)))
	buf.WriteString(value)
}

func writeUint32(buf *bytes.Buffer, value uint32) {
	buf.WriteByte(byte(value >> 24))
	buf.WriteByte(byte(value >> 16))
	buf.WriteByte(byte(value >> 8))
	buf.WriteByte(byte(value))
}

func sortAttrs(attrs []Attr) {
	slices.SortFunc(attrs, func(a, b Attr) int {
		if result := cmp.Compare(a.Namespace, b.Namespace); result != 0 {
			return result
		}
		return cmp.Compare(a.Local, b.Local)
	})
}
