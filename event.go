package dataeng

import (
	"encoding/xml"
	"fmt"
	"strings"
)

// Name is the expanded XML name used by the normalized event stream.
//
// It is an alias of encoding/xml.Name so callers can exchange names with the
// standard library without conversions.
type Name = xml.Name

// ExpandedName is an alias for Name.
type ExpandedName = xml.Name

// EventType identifies the kind of XML event.
type EventType string

// Kind is an alias for EventType.
type Kind = EventType

// EventKind is an alias for EventType.
type EventKind = EventType

// TokenType is an alias for EventType.
type TokenType = EventType

// TokenKind is an alias for EventType.
type TokenKind = EventType

// String returns the event type name.
func (t EventType) String() string { return string(t) }

const (
	// StartElement is emitted for a start tag.
	StartElement EventType = "start-element"
	// EndElement is emitted for an end tag. The decoder also emits one for a
	// self-closing element, immediately after its start element.
	EndElement EventType = "end-element"
	// CharData is emitted for character data, including CDATA sections.
	CharData EventType = "char-data"
	// Comment is emitted for an XML comment.
	Comment EventType = "comment"
	// ProcInst is emitted for a processing instruction, including the XML
	// declaration.
	ProcInst EventType = "proc-inst"
	// Directive is emitted for a document type declaration or another
	// <!...> directive.
	Directive EventType = "directive"
)

// Compatibility aliases for the event constants.
const (
	EventStartElement = StartElement
	EventEndElement   = EndElement
	EventCharData     = CharData
	EventText         = CharData
	EventComment      = Comment
	EventProcInst     = ProcInst
	EventDirective    = Directive

	StartElementEvent = StartElement
	EndElementEvent   = EndElement
	CharDataEvent     = CharData
	TextEvent         = CharData
	CommentEvent      = Comment
	ProcInstEvent     = ProcInst
	DirectiveEvent    = Directive

	StartTagToken = StartElement
	EndTagToken   = EndElement
	TextToken     = CharData
	CommentToken  = Comment
	DoctypeToken  = Directive

	Text                  = CharData
	ProcessingInstruction = ProcInst
)

// Position records an event's location in the original byte stream.
//
// Offset is the zero-based byte offset of the beginning of the event. Line and
// Column are one-based. A column counts bytes, matching encoding/xml, rather
// than Unicode code points. EndOffset is the zero-based offset immediately
// after the event.
type Position struct {
	Offset     int64 `json:"offset"`
	Line       int   `json:"line"`
	Column     int   `json:"column"`
	EndOffset  int64 `json:"end_offset,omitempty"`
	EndLine    int   `json:"end_line,omitempty"`
	EndColumn  int   `json:"end_column,omitempty"`
	ByteOffset int64 `json:"-"`
}

// Location is an alias for Position.
type Location = Position

// String returns the position in line:column form.
func (p Position) String() string {
	return fmt.Sprintf("%d:%d", p.Line, p.Column)
}

// IsZero reports whether the position is the zero value.
func (p Position) IsZero() bool {
	return p.Offset == 0 && p.Line == 0 && p.Column == 0 && p.EndOffset == 0
}

// Namespace describes a namespace declaration on an element.
type Namespace struct {
	Prefix string `json:"prefix,omitempty"`
	URI    string `json:"uri"`
	Space  string `json:"-"`
}

// NamespaceDecl is an alias for Namespace.
type NamespaceDecl = Namespace

// Attr is an attribute with both its expanded name and its original prefix and
// position.
type Attr struct {
	Name         xml.Name `json:"name"`
	ExpandedName xml.Name `json:"-"`
	Prefix       string   `json:"prefix,omitempty"`
	Local        string   `json:"-"`
	Space        string   `json:"-"`
	Value        string   `json:"value"`
	Pos          Position `json:"pos"`
	Position     Position `json:"-"`
}

// Attribute is an alias for Attr.
type Attribute = Attr

// Event is one normalized XML event.
//
// Name always contains an expanded name: Space is the namespace URI (empty for
// no namespace) and Local is the local name. Prefix preserves the lexical
// prefix, which is empty for an unprefixed name. Positions and attribute
// positions refer to the original, unmodified input.
type Event struct {
	Type         EventType         `json:"type"`
	Kind         EventType         `json:"-"`
	EventType    EventType         `json:"-"`
	Name         xml.Name          `json:"name"`
	Expanded     xml.Name          `json:"-"`
	ExpandedName xml.Name          `json:"-"`
	Prefix       string            `json:"prefix,omitempty"`
	QName        string            `json:"qname,omitempty"`
	Local        string            `json:"-"`
	Space        string            `json:"-"`
	Attrs        []Attr            `json:"attrs,omitempty"`
	Attr         []Attr            `json:"-"`
	Attributes   []Attr            `json:"-"`
	Text         string            `json:"text,omitempty"`
	Data         string            `json:"-"`
	Target       string            `json:"target,omitempty"`
	BaseURI      string            `json:"base_uri,omitempty"`
	Base         string            `json:"-"`
	XMLBase      string            `json:"xml_base,omitempty"`
	Namespaces   []Namespace       `json:"namespaces,omitempty"`
	Scope        map[string]string `json:"-"`
	Pos          Position          `json:"pos"`
	Position     Position          `json:"-"`
	Offset       int64             `json:"-"`
	Line         int               `json:"-"`
	Column       int               `json:"-"`
	SelfClosing  bool              `json:"self_closing,omitempty"`
	CDATA        bool              `json:"cdata,omitempty"`
	Synthetic    bool              `json:"synthetic,omitempty"`
}

// Token is an alias for Event.
type Token = Event

// XMLToken is an alias for Event.
type XMLToken = Event

// ExpandedXMLName returns the expanded name of the event.
func (e Event) ExpandedXMLName() xml.Name { return e.Name }

// OriginalPosition returns the original input position of the event.
func (e Event) OriginalPosition() Position { return e.Pos }

// Location returns the original input position of the event.
func (e Event) Location() Position { return e.Pos }

// EffectiveBase returns the xml:base URI in effect for the event.
func (e Event) EffectiveBase() string { return e.BaseURI }

// LookupNamespace looks up a prefix in the namespace scope in effect for the
// event. The empty prefix denotes the default namespace.
func (e Event) LookupNamespace(prefix string) (string, bool) {
	if e.Scope == nil {
		return "", false
	}
	uri, ok := e.Scope[prefix]
	return uri, ok
}

// Attribute returns the first attribute with the given expanded name.
func (e Event) Attribute(space, local string) (string, bool) {
	for _, a := range e.Attrs {
		if a.Name.Space == space && a.Name.Local == local {
			return a.Value, true
		}
	}
	return "", false
}

// String renders a compact event description.
func (e Event) String() string {
	switch e.Type {
	case StartElement, EndElement:
		return fmt.Sprintf("%s %s at %s", e.Type, e.QName, e.Pos)
	case CharData:
		return fmt.Sprintf("%s %q at %s", e.Type, e.Text, e.Pos)
	case Comment, ProcInst, Directive:
		return fmt.Sprintf("%s %q at %s", e.Type, e.Text, e.Pos)
	default:
		return fmt.Sprintf("%s at %s", e.Type, e.Pos)
	}
}

func finishAttr(a Attr) Attr {
	a.ExpandedName = a.Name
	a.Local = a.Name.Local
	a.Space = a.Name.Space
	a.Position = a.Pos
	return a
}

func finishEvent(e Event) Event {
	e.Kind = e.Type
	e.EventType = e.Type
	e.Expanded = e.Name
	e.ExpandedName = e.Name
	e.Local = e.Name.Local
	e.Space = e.Name.Space
	e.Attr = e.Attrs
	e.Attributes = e.Attrs
	e.Data = e.Text
	e.Base = e.BaseURI
	e.Position = e.Pos
	e.Offset = e.Pos.Offset
	e.Line = e.Pos.Line
	e.Column = e.Pos.Column
	return e
}

func qnameString(prefix, local string) string {
	if prefix == "" {
		return local
	}
	if local == "" {
		return prefix
	}
	return strings.Join([]string{prefix, local}, ":")
}
