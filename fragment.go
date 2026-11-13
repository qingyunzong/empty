package dataeng

import (
	"encoding/xml"
	"io"
	"strings"
)

type xmlName = xml.Name

// Kind identifies the kind of a Node.
type Kind uint8

const (
	// ElementNode is an XML element.
	ElementNode Kind = iota
	// TextNode is character data, including CDATA and expanded entities.
	TextNode
	// CommentNode is an XML comment.
	CommentNode
	// ProcInstNode is an XML processing instruction.
	ProcInstNode
)

// Attr is an attribute with a namespace-resolved name. Prefix holds the
// lexical prefix from the input, if any.
type Attr struct {
	Name   xml.Name
	Prefix string
	Value  string
}

// Node is a node in a parsed fragment.
//
// For an element, Name is the namespace-resolved name, Prefix is the lexical
// prefix, Attrs holds non-namespace-declaration attributes, and Children holds
// the element's content. For text and comments, Data holds the text. For a
// processing instruction, Name.Local holds the target and Data holds the
// instruction body.
type Node struct {
	Kind     Kind
	Name     xml.Name
	Prefix   string
	Attrs    []Attr
	Children []*Node
	Data     string
}

// TextContent returns the character data contained in n, in document order.
// Comments and processing instructions are ignored.
func (n *Node) TextContent() string {
	if n == nil {
		return ""
	}
	var b strings.Builder
	n.appendText(&b)
	return b.String()
}

func (n *Node) appendText(b *strings.Builder) {
	switch n.Kind {
	case TextNode:
		b.WriteString(n.Data)
	case ElementNode:
		for _, child := range n.Children {
			child.appendText(b)
		}
	}
}

// Fragment is a parsed XML fragment. A fragment may contain several top-level
// elements, character data, comments, and processing instructions.
type Fragment struct {
	Nodes []*Node
}

// Root returns the first top-level element, or nil if the fragment has none.
func (f *Fragment) Root() *Node {
	if f == nil {
		return nil
	}
	for _, node := range f.Nodes {
		if node.Kind == ElementNode {
			return node
		}
	}
	return nil
}

// Elements returns the top-level element nodes of f.
func (f *Fragment) Elements() []*Node {
	if f == nil {
		return nil
	}
	var elements []*Node
	for _, node := range f.Nodes {
		if node.Kind == ElementNode {
			elements = append(elements, node)
		}
	}
	return elements
}

// ParseFragment parses src as an XML fragment.
//
// maxExpandedBytes bounds the total number of bytes produced by expanding
// internal general entities across the whole fragment. It must be non-negative;
// zero permits no non-empty internal entity expansion. When the limit is
// exceeded, ParseFragment returns an error wrapping ErrExpansionLimit.
//
// The input is treated as UTF-8. No external resource is read.
func ParseFragment(src []byte, maxExpandedBytes int) (*Fragment, error) {
	if maxExpandedBytes < 0 {
		return nil, &ParseError{
			Offset: 0,
			Err:    ErrInvalidLimit,
			Detail: "maxExpandedBytes must not be negative",
		}
	}
	p := newParser(src, maxExpandedBytes)
	return p.parseFragment()
}

// ReadFragment reads all of r and parses it as an XML fragment. See
// ParseFragment for the meaning of maxExpandedBytes.
func ReadFragment(r io.Reader, maxExpandedBytes int) (*Fragment, error) {
	if r == nil {
		return nil, &ParseError{
			Offset: 0,
			Err:    ErrMalformed,
			Detail: "nil reader",
		}
	}
	src, err := io.ReadAll(r)
	if err != nil {
		return nil, &ParseError{
			Offset: 0,
			Err:    ErrMalformed,
			Detail: "read fragment: " + err.Error(),
		}
	}
	return ParseFragment(src, maxExpandedBytes)
}
