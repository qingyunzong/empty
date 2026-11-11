package q213

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
)

// xmlNamespacePrefix is how the encoding/xml decoder marks xmlns
// namespace-declaration attributes in Attr.Name.Space.
const xmlNamespacePrefix = "xmlns"

// Attr is an XML attribute with an expanded (namespace URI, local) name.
// Namespace declarations (xmlns) and prefixes are not retained: the prefix
// is not part of the signed name and must not influence verification.
type Attr struct {
	Namespace string
	Local     string
	Value     string
}

// Node is either an element node (Local != "") or a text node (Local == "").
// Only the XML subset accepted by Parse can be represented: no DTD, no
// comments and no processing instructions survive parsing.
type Node struct {
	Namespace string
	Local     string
	Attrs     []Attr
	Children  []*Node
	Text      string
}

// IsElement reports whether the node is an element node rather than a text node.
func (n *Node) IsElement() bool {
	return n.Local != ""
}

// Attribute returns the attribute value for the expanded name (namespace,
// local). An empty namespace matches an unprefixed attribute.
func (n *Node) Attribute(namespace, local string) (string, bool) {
	for i := range n.Attrs {
		if n.Attrs[i].Namespace == namespace && n.Attrs[i].Local == local {
			return n.Attrs[i].Value, true
		}
	}
	return "", false
}

// TextContent concatenates all descendant text in document order.
func (n *Node) TextContent() string {
	var b bytes.Buffer
	n.textContent(&b)
	return b.String()
}

func (n *Node) textContent(b *bytes.Buffer) {
	if !n.IsElement() {
		b.WriteString(n.Text)
		return
	}
	for _, child := range n.Children {
		child.textContent(b)
	}
}

func rejectDuplicateAttrs(attrs []Attr) error {
	seen := make(map[Attr]struct{}, len(attrs))
	for _, attr := range attrs {
		key := Attr{Namespace: attr.Namespace, Local: attr.Local}
		if _, exists := seen[key]; exists {
			return fmt.Errorf("q213: malformed XML: duplicate attribute {%s}%s",
				attr.Namespace, attr.Local)
		}
		seen[key] = struct{}{}
	}
	return nil
}

var (
	// ErrDTD means the document contains a DOCTYPE or any other directive.
	ErrDTD = errors.New("q213: malformed XML: DTD/directive is not allowed")
	// ErrComment means the document contains an XML comment.
	ErrComment = errors.New("q213: malformed XML: comments are not allowed")
	// ErrProcessingInstruction means the document contains a processing
	// instruction other than the leading XML declaration.
	ErrProcessingInstruction = errors.New("q213: malformed XML: processing instructions are not allowed")
)

// Parse builds the minimal DOM of a document belonging to the restricted XML
// subset. The leading XML declaration is tolerated; every other processing
// instruction, every comment and every directive (including DOCTYPE) is
// rejected. Parsing is strict and unknown entities are not expanded.
func Parse(data []byte) (*Node, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.Strict = true
	decoder.Entity = nil

	var root *Node
	var stack []*Node
	sawRoot := false
	declSeen := false

	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("q213: malformed XML: %w", err)
		}

		switch tok := token.(type) {
		case xml.StartElement:
			node := &Node{
				Namespace: tok.Name.Space,
				Local:     tok.Name.Local,
			}
			for _, a := range tok.Attr {
				if a.Name.Local == "xmlns" || a.Name.Space == xmlNamespacePrefix {
					continue
				}
				node.Attrs = append(node.Attrs, Attr{
					Namespace: a.Name.Space,
					Local:     a.Name.Local,
					Value:     a.Value,
				})
			}
			if err := rejectDuplicateAttrs(node.Attrs); err != nil {
				return nil, err
			}
			sortAttrs(node.Attrs)

			if len(stack) == 0 {
				if sawRoot {
					return nil, errors.New("q213: malformed XML: document must have a single root element")
				}
				root = node
				sawRoot = true
			} else {
				parent := stack[len(stack)-1]
				parent.Children = append(parent.Children, node)
			}
			stack = append(stack, node)

		case xml.EndElement:
			if len(stack) == 0 {
				return nil, errors.New("q213: malformed XML: unmatched end element")
			}
			stack = stack[:len(stack)-1]

		case xml.CharData:
			if len(stack) == 0 {
				return nil, errors.New("q213: malformed XML: text outside the root element")
			}
			parent := stack[len(stack)-1]
			if count := len(parent.Children); count > 0 && !parent.Children[count-1].IsElement() {
				parent.Children[count-1].Text += string(tok)
			} else {
				parent.Children = append(parent.Children, &Node{Text: string(tok)})
			}

		case xml.Comment:
			return nil, ErrComment

		case xml.ProcInst:
			if tok.Target == "xml" && !declSeen && !sawRoot && len(stack) == 0 {
				declSeen = true
				continue
			}
			return nil, ErrProcessingInstruction

		case xml.Directive:
			return nil, ErrDTD
		}
	}

	if !sawRoot {
		return nil, errors.New("q213: malformed XML: empty document")
	}
	if len(stack) != 0 {
		return nil, errors.New("q213: malformed XML: unclosed root element")
	}
	return root, nil
}
