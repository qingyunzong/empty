package dataeng

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
)

// Config is a declarative configuration accepted by Normalize and
// NewNormalizer.
type Config struct {
	BaseURI string
}

// Options is an alias for Config.
type Options = Config

// Option configures a Normalizer.
type Option func(*Config)

// WithBaseURI supplies a base URI against which a document's xml:base values
// are resolved.
func WithBaseURI(uri string) Option {
	return func(c *Config) { c.BaseURI = uri }
}

// WithBase is an alias for WithBaseURI.
func WithBase(uri string) Option { return WithBaseURI(uri) }

// WithConfig applies a Config.
func WithConfig(c Config) Option {
	return func(dst *Config) { *dst = c }
}

// WithOptions applies an Options value.
func WithOptions(c Config) Option { return WithConfig(c) }

type openElement struct {
	name   xml.Name
	prefix string
}

// Normalizer turns an XML document into namespace-normalized events. It reads
// input lazily after construction and is independent of how the underlying
// reader fragments its data.
type Normalizer struct {
	src         []byte
	rec         *recordingReader
	dec         *xml.Decoder
	lineStarts  []int64
	lineScanned int
	cfg         Config
	scope       *nsScope
	elements    []openElement
	current     Event
	err         error
	done        bool
}

// Tokenizer is an alias for Normalizer.
type Tokenizer = Normalizer

// Decoder is an alias for Normalizer.
type Decoder = Normalizer

// Parser is an alias for Normalizer.
type Parser = Normalizer

// Scanner is an alias for Normalizer.
type Scanner = Normalizer

// NewNormalizer creates a normalizer for an io.Reader, string, or []byte.
func NewNormalizer(input any, opts ...any) *Normalizer {
	n := &Normalizer{}
	n.reset(input, opts)
	return n
}

// New creates a normalizer. It is an alias for NewNormalizer.
func New(input any, opts ...any) *Normalizer { return NewNormalizer(input, opts...) }

// NewTokenizer creates a normalizer.
func NewTokenizer(input any, opts ...any) *Normalizer { return NewNormalizer(input, opts...) }

// NewDecoder creates a normalizer.
func NewDecoder(input any, opts ...any) *Normalizer { return NewNormalizer(input, opts...) }

// NewParser creates a normalizer.
func NewParser(input any, opts ...any) *Normalizer { return NewNormalizer(input, opts...) }

// NewScanner creates a normalizer.
func NewScanner(input any, opts ...any) *Normalizer { return NewNormalizer(input, opts...) }

type recordingReader struct {
	r   io.Reader
	buf []byte
}

func (r *recordingReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	if n > 0 {
		r.buf = append(r.buf, p[:n]...)
	}
	return n, err
}

func (n *Normalizer) setInput(input any) error {
	switch v := input.(type) {
	case io.Reader:
		if v == nil {
			return fmt.Errorf("dataeng: nil reader")
		}
		n.rec = &recordingReader{r: v}
		n.dec = xml.NewDecoder(n.rec)
	case []byte:
		n.src = v
		n.dec = xml.NewDecoder(bytes.NewReader(v))
	case string:
		n.src = []byte(v)
		n.dec = xml.NewDecoder(bytes.NewReader(n.src))
	case nil:
		return fmt.Errorf("dataeng: nil input")
	default:
		return fmt.Errorf("dataeng: unsupported input type %T", input)
	}
	n.lineStarts = buildLineStarts(n.src)
	n.lineScanned = len(n.src)
	return nil
}

func (n *Normalizer) syncSource() {
	if n.rec == nil {
		return
	}
	n.src = n.rec.buf
	for i := n.lineScanned; i < len(n.src); i++ {
		if n.src[i] == '\n' {
			n.lineStarts = append(n.lineStarts, int64(i+1))
		}
	}
	n.lineScanned = len(n.src)
}

func applyOptions(dst *Config, opts []any) error {
	for _, opt := range opts {
		switch v := opt.(type) {
		case Option:
			v(dst)
		case func(*Config):
			v(dst)
		case Config:
			*dst = v
		case *Config:
			if v != nil {
				dst.BaseURI = v.BaseURI
			}
		case string:
			dst.BaseURI = v
		case nil:
		default:
			return fmt.Errorf("dataeng: unsupported option type %T", opt)
		}
	}
	return nil
}

func (n *Normalizer) reset(input any, opts []any) {
	*n = Normalizer{}
	if err := applyOptions(&n.cfg, opts); err != nil {
		n.err = err
		return
	}
	if err := n.setInput(input); err != nil {
		n.err = err
		return
	}
	n.dec.Strict = true
	n.dec.Entity = nil
	n.dec.CharsetReader = nil
	n.scope = &nsScope{
		defaultSet: true,
		defaultURI: "",
		baseURI:    n.cfg.BaseURI,
	}
}

// Reset discards the current event stream and starts over with another input.
func (n *Normalizer) Reset(input any, opts ...any) {
	previous := n.cfg
	n.reset(input, append([]any{Option(func(c *Config) { *c = previous })}, opts...))
}

func buildLineStarts(src []byte) []int64 {
	starts := make([]int64, 1, 1+bytes.Count(src, []byte{'\n'}))
	starts[0] = 0
	for i, b := range src {
		if b == '\n' {
			starts = append(starts, int64(i+1))
		}
	}
	return starts
}

func positionAt(lineStarts []int64, offset, end int64) Position {
	if offset < 0 {
		offset = 0
	}
	line := sort.Search(len(lineStarts), func(i int) bool {
		return lineStarts[i] > offset
	}) - 1
	if line < 0 {
		line = 0
	}

	p := Position{
		Offset:    offset,
		Line:      line + 1,
		Column:    int(offset-lineStarts[line]) + 1,
		EndOffset: end,
	}
	if end > 0 {
		endLine := sort.Search(len(lineStarts), func(i int) bool {
			return lineStarts[i] > end
		}) - 1
		if endLine < 0 {
			endLine = 0
		}
		p.EndLine = endLine + 1
		p.EndColumn = int(end-lineStarts[endLine]) + 1
	}
	p.ByteOffset = p.Offset
	return p
}

// Next returns the next normalized event. It returns io.EOF at the end of the
// document. Once an error is returned, the same error is returned on
// subsequent calls.
func (n *Normalizer) Next() (Event, error) {
	if n.err != nil {
		return Event{}, n.err
	}
	if n.done {
		return Event{}, io.EOF
	}

	for {
		start := n.dec.InputOffset()
		tok, err := n.dec.Token()
		n.syncSource()
		end := n.dec.InputOffset()
		if err != nil {
			n.done = true
			if errors.Is(err, io.EOF) {
				n.err = io.EOF
				return Event{}, io.EOF
			}
			err = n.classifyTokenError(err, start)
			if strings.Contains(err.Error(), "invalid character entity") {
				err = fmt.Errorf("%w: %v", ErrUnknownEntity, err)
			}
			n.err = err
			return Event{}, err
		}

		var raw []byte
		if start >= 0 && end >= start && end <= int64(len(n.src)) {
			raw = n.src[start:end]
		}
		if isBOMToken(tok, start, raw) {
			continue
		}

		ev, err := n.normalizeToken(tok, raw, start, end)
		if err != nil {
			n.err = err
			n.done = true
			return Event{}, err
		}
		n.current = ev
		return ev, nil
	}
}

func (n *Normalizer) classifyTokenError(err error, start int64) error {
	if start < 0 || start >= int64(len(n.src)) || n.scope == nil {
		return err
	}
	rest := n.src[start:]
	if !bytes.HasPrefix(rest, []byte("</")) {
		return err
	}
	if i := bytes.IndexByte(rest, '>'); i >= 0 {
		if tag, parseErr := parseRawEndTag(rest[:i+1], start); parseErr == nil {
			uri, ok := n.scope.resolvePrefix(tag.prefix)
			if !ok || (tag.prefix != "" && uri == "") {
				return &PrefixError{
					Prefix:   tag.prefix,
					Position: positionAt(n.lineStarts, tag.offset, tag.endOffset),
				}
			}
		}
	}
	return err
}

// Token returns the next event. It is an alias for Next.
func (n *Normalizer) Token() (Event, error) { return n.Next() }

// NextEvent returns the next event.
func (n *Normalizer) NextEvent() (Event, error) { return n.Next() }

// ReadEvent returns the next event.
func (n *Normalizer) ReadEvent() (Event, error) { return n.Next() }

// Scan advances to the next event and reports whether one was available. It is
// the bufio.Scanner-style interface to Next.
func (n *Normalizer) Scan() bool {
	ev, err := n.Next()
	if err != nil {
		return false
	}
	n.current = ev
	return true
}

// Event returns the event most recently returned by Scan.
func (n *Normalizer) Event() Event { return n.current }

// Err returns the first non-EOF error encountered.
func (n *Normalizer) Err() error {
	if errors.Is(n.err, io.EOF) {
		return nil
	}
	return n.err
}

// All reads and returns every event. If the document is rejected, it returns a
// nil event slice and the error.
func (n *Normalizer) All() ([]Event, error) {
	var out []Event
	for {
		ev, err := n.Next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return out, nil
			}
			return nil, err
		}
		out = append(out, ev)
	}
}

// Events is an alias for All.
func (n *Normalizer) Events() ([]Event, error) { return n.All() }

// ReadAll is an alias for All.
func (n *Normalizer) ReadAll() ([]Event, error) { return n.All() }

// Normalize is an alias for All.
func (n *Normalizer) Normalize() ([]Event, error) { return n.All() }

// Tokens is an alias for All.
func (n *Normalizer) Tokens() ([]Event, error) { return n.All() }

// InputOffset returns the byte offset at the end of the most recently returned
// event.
func (n *Normalizer) InputOffset() int64 {
	if n.dec == nil {
		return 0
	}
	return n.dec.InputOffset()
}

// InputPos returns the one-based line and column at the end of the most
// recently returned event.
func (n *Normalizer) InputPos() (line, column int) {
	if n.dec == nil {
		return 1, 1
	}
	return n.dec.InputPos()
}

func isBOMToken(tok xml.Token, start int64, raw []byte) bool {
	if start != 0 || len(raw) != 3 {
		return false
	}
	if _, ok := tok.(xml.CharData); !ok {
		return false
	}
	return raw[0] == 0xef && raw[1] == 0xbb && raw[2] == 0xbf
}

func (n *Normalizer) normalizeToken(tok xml.Token, raw []byte, start, end int64) (Event, error) {
	switch t := tok.(type) {
	case xml.StartElement:
		return n.normalizeStart(t, raw, start, end)
	case xml.EndElement:
		return n.normalizeEnd(t, raw, start, end)
	case xml.CharData:
		ev := Event{
			Type:    CharData,
			Text:    string(t),
			Pos:     positionAt(n.lineStarts, start, end),
			BaseURI: n.scope.baseURI,
			Scope:   n.scope.snapshot(),
			CDATA:   bytes.HasPrefix(raw, []byte("<![CDATA[")),
		}
		return finishEvent(ev), nil
	case xml.Comment:
		ev := Event{
			Type:    Comment,
			Text:    string(t),
			Pos:     positionAt(n.lineStarts, start, end),
			BaseURI: n.scope.baseURI,
			Scope:   n.scope.snapshot(),
		}
		return finishEvent(ev), nil
	case xml.ProcInst:
		ev := Event{
			Type:    ProcInst,
			Target:  t.Target,
			Text:    string(t.Inst),
			Pos:     positionAt(n.lineStarts, start, end),
			BaseURI: n.scope.baseURI,
			Scope:   n.scope.snapshot(),
		}
		return finishEvent(ev), nil
	case xml.Directive:
		ev := Event{
			Type:    Directive,
			Text:    string(t),
			Pos:     positionAt(n.lineStarts, start, end),
			BaseURI: n.scope.baseURI,
			Scope:   n.scope.snapshot(),
		}
		return finishEvent(ev), nil
	default:
		return Event{}, fmt.Errorf("dataeng: unsupported XML token %T", tok)
	}
}

func (n *Normalizer) normalizeStart(t xml.StartElement, raw []byte, start, end int64) (Event, error) {
	tag, err := parseRawStartTag(raw, start)
	if err != nil {
		return Event{}, &PositionError{Position: positionAt(n.lineStarts, start, start), Err: err}
	}

	decls := make(map[string]string)
	namespaces := make([]Namespace, 0)
	defaultDeclared := false
	defaultURI := ""

	for _, attr := range tag.attrs {
		switch {
		case attr.prefix == "" && attr.local == "xmlns":
			if defaultDeclared {
				return Event{}, &PositionError{
					Position: positionAt(n.lineStarts, attr.offset, attr.endOffset),
					Err:      fmt.Errorf("%w: duplicate default namespace", ErrInvalidNamespace),
				}
			}
			if err := validateNamespaceDecl("", attr.value); err != nil {
				return Event{}, &PositionError{Position: positionAt(n.lineStarts, attr.offset, attr.endOffset), Err: err}
			}
			defaultDeclared = true
			defaultURI = attr.value
			namespaces = append(namespaces, Namespace{Prefix: "", URI: attr.value, Space: attr.value})
		case attr.prefix == "xmlns":
			if _, exists := decls[attr.local]; exists {
				return Event{}, &PositionError{
					Position: positionAt(n.lineStarts, attr.offset, attr.endOffset),
					Err:      fmt.Errorf("%w: duplicate binding for %q", ErrInvalidNamespace, attr.local),
				}
			}
			if err := validateNamespaceDecl(attr.local, attr.value); err != nil {
				return Event{}, &PositionError{Position: positionAt(n.lineStarts, attr.offset, attr.endOffset), Err: err}
			}
			decls[attr.local] = attr.value
			namespaces = append(namespaces, Namespace{Prefix: attr.local, URI: attr.value, Space: attr.value})
		}
	}

	frame := &nsScope{
		parent:  n.scope,
		decls:   decls,
		baseURI: n.scope.baseURI,
	}
	if defaultDeclared {
		frame.defaultSet = true
		frame.defaultURI = defaultURI
	} else {
		frame.defaultSet = n.scope.defaultSet
		frame.defaultURI = n.scope.defaultURI
	}

	name, err := resolveElementName(frame, tag.prefix, tag.local, positionAt(n.lineStarts, tag.offset, tag.endOffset))
	if err != nil {
		return Event{}, err
	}

	attrs := make([]Attr, 0, len(tag.attrs))
	seen := make(map[string]struct{}, len(tag.attrs))
	baseValue := ""
	haveBase := false
	for _, attr := range tag.attrs {
		var expanded xml.Name
		prefix := attr.prefix
		switch {
		case attr.prefix == "" && attr.local == "xmlns":
			expanded = xml.Name{Local: "xmlns"}
			prefix = ""
		case attr.prefix == "xmlns":
			expanded = xml.Name{Space: "xmlns", Local: attr.local}
			prefix = "xmlns"
		case attr.prefix == "":
			expanded = xml.Name{Local: attr.local}
			prefix = ""
		case attr.prefix == "xml":
			expanded = xml.Name{Space: xmlNamespaceURI, Local: attr.local}
			prefix = "xml"
		default:
			uri, ok := frame.lookup(attr.prefix)
			if !ok || uri == "" {
				return Event{}, &PrefixError{
					Prefix:   attr.prefix,
					Position: positionAt(n.lineStarts, attr.offset, attr.endOffset),
				}
			}
			expanded = xml.Name{Space: uri, Local: attr.local}
		}

		key := expanded.Space + "\x00" + expanded.Local
		if _, exists := seen[key]; exists {
			return Event{}, &PositionError{
				Position: positionAt(n.lineStarts, attr.offset, attr.endOffset),
				Err:      fmt.Errorf("duplicate attribute {%s}%s", expanded.Space, expanded.Local),
			}
		}
		seen[key] = struct{}{}

		if expanded.Space == xmlNamespaceURI && expanded.Local == "base" {
			baseValue = attr.value
			haveBase = true
		}
		attrs = append(attrs, finishAttr(Attr{
			Name:   expanded,
			Prefix: prefix,
			Value:  attr.value,
			Pos:    positionAt(n.lineStarts, attr.offset, attr.endOffset),
		}))
	}

	if haveBase {
		resolved, err := resolveBaseURI(n.scope.baseURI, baseValue)
		if err != nil {
			return Event{}, &PositionError{Position: positionAt(n.lineStarts, start, start), Err: err}
		}
		frame.baseURI = resolved
	}

	ev := Event{
		Type:        StartElement,
		Name:        name,
		QName:       tag.qname,
		Prefix:      tag.prefix,
		Attrs:       attrs,
		Text:        "",
		BaseURI:     frame.baseURI,
		XMLBase:     baseValue,
		Namespaces:  namespaces,
		Scope:       frame.snapshot(),
		Pos:         positionAt(n.lineStarts, start, end),
		SelfClosing: tag.selfClosing,
	}
	n.scope = frame
	n.elements = append(n.elements, openElement{name: name, prefix: tag.prefix})
	return finishEvent(ev), nil
}

func resolveElementName(scope *nsScope, prefix, local string, pos Position) (xml.Name, error) {
	if prefix == "xmlns" {
		return xml.Name{}, &PrefixError{Prefix: prefix, Position: pos}
	}
	uri, ok := scope.resolvePrefix(prefix)
	if !ok {
		return xml.Name{}, &PrefixError{Prefix: prefix, Position: pos}
	}
	if prefix != "" && uri == "" {
		return xml.Name{}, &PrefixError{Prefix: prefix, Position: pos}
	}
	return xml.Name{Space: uri, Local: local}, nil
}

func (n *Normalizer) normalizeEnd(t xml.EndElement, raw []byte, start, end int64) (Event, error) {
	if len(n.elements) == 0 {
		return Event{}, &PositionError{
			Position: positionAt(n.lineStarts, start, end),
			Err:      fmt.Errorf("unexpected end element"),
		}
	}
	top := n.elements[len(n.elements)-1]
	prefix := top.prefix
	name := top.name
	synthetic := len(raw) == 0

	if !synthetic {
		tag, err := parseRawEndTag(raw, start)
		if err != nil {
			return Event{}, &PositionError{Position: positionAt(n.lineStarts, start, start), Err: err}
		}
		prefix = tag.prefix
		name, err = resolveElementName(n.scope, tag.prefix, tag.local, positionAt(n.lineStarts, start, end))
		if err != nil {
			return Event{}, err
		}
		if name != top.name {
			return Event{}, &PositionError{
				Position: positionAt(n.lineStarts, start, end),
				Err:      fmt.Errorf("end element %s does not match %s", name, top.name),
			}
		}
	}

	ev := Event{
		Type:      EndElement,
		Name:      name,
		QName:     qnameString(prefix, name.Local),
		Prefix:    prefix,
		BaseURI:   n.scope.baseURI,
		Scope:     n.scope.snapshot(),
		Pos:       positionAt(n.lineStarts, start, end),
		Synthetic: synthetic,
	}
	n.elements = n.elements[:len(n.elements)-1]
	n.scope = n.scope.parent
	return finishEvent(ev), nil
}

// Normalize parses an XML document and returns all normalized events. The input
// may be an io.Reader, string, or []byte. If the document is rejected, the
// returned slice is nil.
func Normalize(input any, opts ...any) ([]Event, error) {
	return NewNormalizer(input, opts...).All()
}

// Parse is an alias for Normalize.
func Parse(input any, opts ...any) ([]Event, error) { return Normalize(input, opts...) }

// NormalizeXML is an alias for Normalize.
func NormalizeXML(input any, opts ...any) ([]Event, error) { return Normalize(input, opts...) }

// ParseXML is an alias for Normalize.
func ParseXML(input any, opts ...any) ([]Event, error) { return Normalize(input, opts...) }

// Decode is an alias for Normalize.
func Decode(input any, opts ...any) ([]Event, error) { return Normalize(input, opts...) }

// Events is an alias for Normalize.
func Events(input any, opts ...any) ([]Event, error) { return Normalize(input, opts...) }

// Tokenize is an alias for Normalize.
func Tokenize(input any, opts ...any) ([]Event, error) { return Normalize(input, opts...) }

// NormalizeBytes normalizes a byte slice.
func NormalizeBytes(input []byte, opts ...any) ([]Event, error) { return Normalize(input, opts...) }

// NormalizeString normalizes a string.
func NormalizeString(input string, opts ...any) ([]Event, error) { return Normalize(input, opts...) }

// ParseBytes normalizes a byte slice.
func ParseBytes(input []byte, opts ...any) ([]Event, error) { return Normalize(input, opts...) }

// ParseString normalizes a string.
func ParseString(input string, opts ...any) ([]Event, error) { return Normalize(input, opts...) }
