package dataeng

import (
	"bytes"
	"fmt"
	"strings"
	"unicode/utf8"
)

const maxEntityNesting = 64

const (
	xmlNamespace   = "http://www.w3.org/XML/1998/namespace"
	xmlnsNamespace = "http://www.w3.org/2000/xmlns/"
)

type parser struct {
	src      []byte
	pos      int
	max      int
	expanded int
	entities map[string]string
}

func newParser(src []byte, maxExpandedBytes int) *parser {
	return &parser{
		src:      src,
		max:      maxExpandedBytes,
		entities: make(map[string]string),
	}
}

func (p *parser) errf(base error, offset int, format string, args ...any) error {
	return &ParseError{Offset: offset, Err: base, Detail: fmt.Sprintf(format, args...)}
}

func (p *parser) parseFragment() (*Fragment, error) {
	p.skipBOM()
	if err := p.parseXMLDeclaration(); err != nil {
		return nil, err
	}

	fragment := &Fragment{}
	ns := initialNS()
	seenDoctype := false
	seenElement := false
	seenNonSpace := false

	for !p.eof() {
		switch {
		case p.has("<!--"):
			node, err := p.parseComment()
			if err != nil {
				return nil, err
			}
			fragment.Nodes = appendNode(fragment.Nodes, node)
		case p.has("<?"):
			node, err := p.parsePI()
			if err != nil {
				return nil, err
			}
			fragment.Nodes = appendNode(fragment.Nodes, node)
		case p.has("<!DOCTYPE"):
			if seenDoctype || seenElement || seenNonSpace {
				return nil, p.errf(ErrMalformed, p.pos, "DOCTYPE must precede fragment content")
			}
			if err := p.parseDoctype(); err != nil {
				return nil, err
			}
			seenDoctype = true
		case p.has("<![CDATA["):
			node, err := p.parseCDATA()
			if err != nil {
				return nil, err
			}
			fragment.Nodes = appendNode(fragment.Nodes, node)
			seenNonSpace = true
		case p.has("</"):
			return nil, p.errf(ErrMalformed, p.pos, "unexpected end tag")
		case p.has("<!"):
			return nil, p.errf(ErrMalformed, p.pos, "unexpected markup declaration")
		case p.peek() == '<':
			node, err := p.parseElement(ns)
			if err != nil {
				return nil, err
			}
			fragment.Nodes = appendNode(fragment.Nodes, node)
			seenElement = true
			seenNonSpace = true
		default:
			node, err := p.parseText()
			if err != nil {
				return nil, err
			}
			if node != nil {
				if strings.TrimSpace(node.Data) != "" {
					seenNonSpace = true
				}
				fragment.Nodes = appendNode(fragment.Nodes, node)
			}
		}
	}

	return fragment, nil
}

func appendNode(nodes []*Node, node *Node) []*Node {
	if node == nil {
		return nodes
	}
	if node.Kind == TextNode && len(nodes) > 0 && nodes[len(nodes)-1].Kind == TextNode {
		nodes[len(nodes)-1].Data += node.Data
		return nodes
	}
	return append(nodes, node)
}

func (p *parser) parseXMLDeclaration() error {
	if !p.has("<?xml") {
		return nil
	}
	if p.pos+5 < len(p.src) && !isXMLSpace(p.src[p.pos+5]) {
		// Something like <?xml-stylesheet ...?> is a normal processing
		// instruction, not an XML declaration.
		return nil
	}
	start := p.pos
	end := bytes.Index(p.src[p.pos+5:], []byte("?>"))
	if end < 0 {
		return p.errf(ErrMalformed, start, "unterminated XML declaration")
	}
	content := p.src[p.pos+5 : p.pos+5+end]
	attrs, err := parseDeclarationAttrs(content)
	if err != nil {
		return p.errf(ErrMalformed, start, "%v", err)
	}
	for name := range attrs {
		switch name {
		case "version", "encoding", "standalone":
		default:
			return p.errf(ErrMalformed, start, "unknown XML declaration attribute %q", name)
		}
	}
	if version, ok := attrs["version"]; ok && version != "1.0" {
		return p.errf(ErrUnsupported, start, "XML version %q", version)
	}
	if enc, ok := attrs["encoding"]; ok {
		switch strings.ToLower(enc) {
		case "utf-8", "utf8", "us-ascii", "ascii":
		default:
			return p.errf(ErrUnsupported, start, "encoding %q is not supported", enc)
		}
	}
	if standalone, ok := attrs["standalone"]; ok && standalone != "yes" && standalone != "no" {
		return p.errf(ErrMalformed, start, "invalid standalone value %q", standalone)
	}
	p.pos += 5 + end + 2
	return nil
}

func parseDeclarationAttrs(content []byte) (map[string]string, error) {
	attrs := make(map[string]string)
	pos := 0
	for {
		for pos < len(content) && isXMLSpace(content[pos]) {
			pos++
		}
		if pos >= len(content) {
			return attrs, nil
		}
		name, err := scanNameBytes(content, &pos)
		if err != nil || !validNCName(name) {
			return nil, fmt.Errorf("invalid XML declaration")
		}
		for pos < len(content) && isXMLSpace(content[pos]) {
			pos++
		}
		if pos >= len(content) || content[pos] != '=' {
			return nil, fmt.Errorf("invalid XML declaration attribute")
		}
		pos++
		for pos < len(content) && isXMLSpace(content[pos]) {
			pos++
		}
		if pos >= len(content) || content[pos] != '"' && content[pos] != '\'' {
			return nil, fmt.Errorf("invalid XML declaration attribute value")
		}
		quote := content[pos]
		pos++
		valueStart := pos
		for pos < len(content) && content[pos] != quote {
			pos++
		}
		if pos >= len(content) {
			return nil, fmt.Errorf("unterminated XML declaration attribute value")
		}
		if _, exists := attrs[name]; exists {
			return nil, fmt.Errorf("duplicate XML declaration attribute %q", name)
		}
		value := string(content[valueStart:pos])
		if err := validateXMLString(value); err != nil {
			return nil, err
		}
		attrs[name] = value
		pos++
	}
}

func (p *parser) parseComment() (*Node, error) {
	start := p.pos
	p.pos += len("<!--")
	end := bytes.Index(p.src[p.pos:], []byte("-->"))
	if end < 0 {
		return nil, p.errf(ErrMalformed, start, "unterminated comment")
	}
	content := p.src[p.pos : p.pos+end]
	if bytes.Contains(content, []byte("--")) {
		return nil, p.errf(ErrMalformed, start, "invalid '--' inside comment")
	}
	if err := validateXMLString(string(content)); err != nil {
		return nil, p.errf(ErrMalformed, start, "%v", err)
	}
	p.pos += end + len("-->")
	return &Node{Kind: CommentNode, Data: normalizeLineEndings(string(content))}, nil
}

func (p *parser) parsePI() (*Node, error) {
	start := p.pos
	p.pos += len("<?")
	target, err := p.scanName()
	if err != nil {
		return nil, p.errf(ErrMalformed, start, "invalid processing instruction target")
	}
	if strings.EqualFold(target, "xml") {
		return nil, p.errf(ErrMalformed, start, "processing instruction target 'xml' is reserved")
	}
	if !p.eof() && !isXMLSpace(p.peek()) && !p.has("?>") {
		return nil, p.errf(ErrMalformed, p.pos, "invalid processing instruction target")
	}
	p.skipSpaces()
	dataStart := p.pos
	end := bytes.Index(p.src[p.pos:], []byte("?>"))
	if end < 0 {
		return nil, p.errf(ErrMalformed, start, "unterminated processing instruction")
	}
	data := p.src[dataStart : dataStart+end]
	if err := validateXMLString(string(data)); err != nil {
		return nil, p.errf(ErrMalformed, start, "%v", err)
	}
	p.pos += end + len("?>")
	return &Node{
		Kind: ProcInstNode,
		Name: xmlName{Local: target},
		Data: normalizeLineEndings(string(data)),
	}, nil
}

func (p *parser) parseCDATA() (*Node, error) {
	start := p.pos
	p.pos += len("<![CDATA[")
	end := bytes.Index(p.src[p.pos:], []byte("]]>"))
	if end < 0 {
		return nil, p.errf(ErrMalformed, start, "unterminated CDATA section")
	}
	content := p.src[p.pos : p.pos+end]
	if err := validateXMLString(string(content)); err != nil {
		return nil, p.errf(ErrMalformed, start, "%v", err)
	}
	p.pos += end + len("]]>")
	return &Node{Kind: TextNode, Data: normalizeLineEndings(string(content))}, nil
}

func (p *parser) parseText() (*Node, error) {
	var b strings.Builder
	for !p.eof() {
		switch c := p.peek(); {
		case c == '<':
			if b.Len() == 0 {
				return nil, nil
			}
			return &Node{Kind: TextNode, Data: b.String()}, nil
		case c == '&':
			if err := p.parseDocReference(&b); err != nil {
				return nil, err
			}
		case c == '\r':
			p.pos++
			if !p.eof() && p.peek() == '\n' {
				p.pos++
			}
			b.WriteByte('\n')
		case c == ']' && p.has("]]>"):
			return nil, p.errf(ErrMalformed, p.pos, "']]>' is not allowed in character data")
		default:
			r, size := utf8.DecodeRune(p.src[p.pos:])
			if r == utf8.RuneError && size == 1 {
				return nil, p.errf(ErrMalformed, p.pos, "invalid UTF-8")
			}
			if !validXMLChar(r) {
				return nil, p.errf(ErrMalformed, p.pos, "illegal XML character %U", r)
			}
			b.WriteRune(r)
			p.pos += size
		}
	}
	if b.Len() == 0 {
		return nil, nil
	}
	return &Node{Kind: TextNode, Data: b.String()}, nil
}

func (p *parser) parseDocReference(out *strings.Builder) error {
	offset := p.pos
	text, name, next, err := decodeReference(p.src, p.pos)
	if err != nil {
		return p.errf(ErrMalformed, offset, "%v", err)
	}
	p.pos = next
	if name == "" {
		out.WriteString(text)
		return nil
	}
	if value, ok := builtinEntity(name); ok {
		out.WriteString(value)
		return nil
	}
	if _, ok := p.entities[name]; !ok {
		return p.errf(ErrUndefinedEntity, offset, "entity %q is not declared", name)
	}
	return p.expandEntity(name, out, nil, offset)
}

type rawAttr struct {
	name   string
	value  string
	offset int
}

func (p *parser) parseElement(parentNS map[string]string) (*Node, error) {
	start := p.pos
	p.pos++ // '<'
	rawName, err := p.scanName()
	if err != nil {
		return nil, err
	}
	prefix, local, err := p.splitQName(rawName, start+1)
	if err != nil {
		return nil, err
	}

	attrs, selfClosing, err := p.parseAttributes()
	if err != nil {
		return nil, err
	}

	ns := cloneNS(parentNS)
	for _, attr := range attrs {
		if err := p.applyNamespaceDecl(ns, attr); err != nil {
			return nil, err
		}
	}

	name, err := p.resolveName(ns, prefix, local, false, start+1)
	if err != nil {
		return nil, err
	}
	node := &Node{
		Kind:   ElementNode,
		Name:   name,
		Prefix: prefix,
	}

	seen := make(map[xmlAttrName]bool)
	for _, attr := range attrs {
		if isNamespaceDecl(attr.name) {
			continue
		}
		attrPrefix, attrLocal, err := p.splitQName(attr.name, attr.offset)
		if err != nil {
			return nil, err
		}
		attrName, err := p.resolveName(ns, attrPrefix, attrLocal, true, attr.offset)
		if err != nil {
			return nil, err
		}
		key := xmlAttrName{space: attrName.Space, local: attrName.Local}
		if seen[key] {
			return nil, p.errf(ErrMalformed, attr.offset, "duplicate attribute %q", attr.name)
		}
		seen[key] = true
		node.Attrs = append(node.Attrs, Attr{
			Name:   attrName,
			Prefix: attrPrefix,
			Value:  attr.value,
		})
	}

	if selfClosing {
		return node, nil
	}
	children, err := p.parseElementContent(ns, rawName)
	if err != nil {
		return nil, err
	}
	node.Children = children
	return node, nil
}

func (p *parser) parseAttributes() ([]rawAttr, bool, error) {
	var attrs []rawAttr
	seenRaw := make(map[string]bool)
	for {
		p.skipSpaces()
		if p.eof() {
			return nil, false, p.errf(ErrMalformed, p.pos, "unterminated start tag")
		}
		switch p.peek() {
		case '>':
			p.pos++
			return attrs, false, nil
		case '/':
			p.pos++
			if p.eof() || p.peek() != '>' {
				return nil, false, p.errf(ErrMalformed, p.pos, "expected '>' after '/'")
			}
			p.pos++
			return attrs, true, nil
		}

		offset := p.pos
		name, err := p.scanName()
		if err != nil {
			return nil, false, err
		}
		if _, _, err := p.splitQName(name, offset); err != nil {
			return nil, false, err
		}
		if seenRaw[name] {
			return nil, false, p.errf(ErrMalformed, offset, "duplicate attribute %q", name)
		}
		seenRaw[name] = true

		p.skipSpaces()
		if p.eof() || p.peek() != '=' {
			return nil, false, p.errf(ErrMalformed, p.pos, "expected '=' after attribute name")
		}
		p.pos++
		p.skipSpaces()
		if p.eof() || p.peek() != '"' && p.peek() != '\'' {
			return nil, false, p.errf(ErrMalformed, p.pos, "expected quoted attribute value")
		}
		value, err := p.parseAttributeValue()
		if err != nil {
			return nil, false, err
		}
		attrs = append(attrs, rawAttr{name: name, value: value, offset: offset})
	}
}

func (p *parser) parseAttributeValue() (string, error) {
	quote := p.peek()
	p.pos++
	var b strings.Builder
	for !p.eof() {
		c := p.peek()
		switch {
		case c == quote:
			p.pos++
			return b.String(), nil
		case c == '<':
			return "", p.errf(ErrMalformed, p.pos, "'<' is not allowed in an attribute value")
		case c == '&':
			if err := p.parseDocReference(&b); err != nil {
				return "", err
			}
		case c == '\r':
			p.pos++
			if !p.eof() && p.peek() == '\n' {
				p.pos++
			}
			b.WriteByte(' ')
		case c == '\n' || c == '\t':
			p.pos++
			b.WriteByte(' ')
		default:
			r, size := utf8.DecodeRune(p.src[p.pos:])
			if r == utf8.RuneError && size == 1 {
				return "", p.errf(ErrMalformed, p.pos, "invalid UTF-8")
			}
			if !validXMLChar(r) {
				return "", p.errf(ErrMalformed, p.pos, "illegal XML character %U", r)
			}
			b.WriteRune(r)
			p.pos += size
		}
	}
	return "", p.errf(ErrMalformed, p.pos, "unterminated attribute value")
}

func (p *parser) parseElementContent(ns map[string]string, startName string) ([]*Node, error) {
	var children []*Node
	for {
		if p.eof() {
			return nil, p.errf(ErrMalformed, p.pos, "unclosed element %q", startName)
		}
		switch {
		case p.has("</"):
			if err := p.parseEndTag(startName); err != nil {
				return nil, err
			}
			return children, nil
		case p.has("<!--"):
			node, err := p.parseComment()
			if err != nil {
				return nil, err
			}
			children = appendNode(children, node)
		case p.has("<?"):
			node, err := p.parsePI()
			if err != nil {
				return nil, err
			}
			children = appendNode(children, node)
		case p.has("<![CDATA["):
			node, err := p.parseCDATA()
			if err != nil {
				return nil, err
			}
			children = appendNode(children, node)
		case p.has("<!"):
			return nil, p.errf(ErrMalformed, p.pos, "unexpected markup declaration in element content")
		case p.peek() == '<':
			node, err := p.parseElement(ns)
			if err != nil {
				return nil, err
			}
			children = appendNode(children, node)
		default:
			node, err := p.parseText()
			if err != nil {
				return nil, err
			}
			children = appendNode(children, node)
		}
	}
}

func (p *parser) parseEndTag(expected string) error {
	start := p.pos
	p.pos += len("</")
	name, err := p.scanName()
	if err != nil {
		return err
	}
	if _, _, err := p.splitQName(name, start+2); err != nil {
		return err
	}
	if name != expected {
		return p.errf(ErrMalformed, start, "end tag %q does not match start tag %q", name, expected)
	}
	p.skipSpaces()
	if p.eof() || p.peek() != '>' {
		return p.errf(ErrMalformed, p.pos, "expected '>' at end of end tag")
	}
	p.pos++
	return nil
}

func initialNS() map[string]string {
	return map[string]string{
		"":    "",
		"xml": xmlNamespace,
	}
}

func cloneNS(src map[string]string) map[string]string {
	dst := make(map[string]string, len(src)+1)
	for prefix, uri := range src {
		dst[prefix] = uri
	}
	return dst
}

func isNamespaceDecl(name string) bool {
	return name == "xmlns" || strings.HasPrefix(name, "xmlns:")
}

func (p *parser) applyNamespaceDecl(ns map[string]string, attr rawAttr) error {
	if attr.name == "xmlns" {
		uri := attr.value
		if uri == xmlNamespace || uri == xmlnsNamespace {
			return p.errf(ErrMalformed, attr.offset, "reserved namespace URI cannot be the default namespace")
		}
		ns[""] = uri
		return nil
	}
	if !strings.HasPrefix(attr.name, "xmlns:") {
		return nil
	}
	prefix := strings.TrimPrefix(attr.name, "xmlns:")
	if prefix == "" || !validNCName(prefix) {
		return p.errf(ErrMalformed, attr.offset, "invalid namespace declaration %q", attr.name)
	}
	if prefix == "xmlns" {
		return p.errf(ErrMalformed, attr.offset, "the 'xmlns' prefix is reserved")
	}
	if prefix == "xml" {
		if attr.value != xmlNamespace {
			return p.errf(ErrMalformed, attr.offset, "the 'xml' prefix is reserved")
		}
		ns["xml"] = xmlNamespace
		return nil
	}
	if attr.value == "" {
		return p.errf(ErrMalformed, attr.offset, "namespace prefix %q cannot be undeclared", prefix)
	}
	if attr.value == xmlNamespace || attr.value == xmlnsNamespace {
		return p.errf(ErrMalformed, attr.offset, "reserved namespace URI cannot be bound to prefix %q", prefix)
	}
	ns[prefix] = attr.value
	return nil
}

type xmlAttrName struct {
	space string
	local string
}

func (p *parser) resolveName(ns map[string]string, prefix, local string, attribute bool, offset int) (xmlName, error) {
	if prefix == "" {
		if attribute {
			return xmlName{Local: local}, nil
		}
		return xmlName{Space: ns[""], Local: local}, nil
	}
	if prefix == "xmlns" {
		return xmlName{}, p.errf(ErrUndeclaredPrefix, offset, "the 'xmlns' prefix is reserved")
	}
	uri, ok := ns[prefix]
	if !ok {
		return xmlName{}, p.errf(ErrUndeclaredPrefix, offset, "prefix %q is not declared", prefix)
	}
	return xmlName{Space: uri, Local: local}, nil
}

func (p *parser) expandEntity(name string, out *strings.Builder, stack []string, refOffset int) error {
	if len(stack) >= maxEntityNesting {
		return p.errf(ErrEntityDepth, refOffset, "entity nesting exceeds %d", maxEntityNesting)
	}
	for _, active := range stack {
		if active == name {
			return p.errf(ErrEntityLoop, refOffset, "entity %q references itself", name)
		}
	}
	value, ok := p.entities[name]
	if !ok {
		return p.errf(ErrUndefinedEntity, refOffset, "entity %q is not declared", name)
	}
	stack = append(stack, name)

	data := []byte(value)
	literalStart := 0
	for i := 0; i < len(data); {
		if data[i] != '&' {
			i++
			continue
		}
		if literalStart < i {
			if err := p.emitExpanded(out, string(data[literalStart:i]), refOffset); err != nil {
				return err
			}
		}
		text, refName, next, err := decodeReference(data, i)
		if err != nil {
			return p.errf(ErrMalformed, refOffset, "invalid reference in entity %q: %v", name, err)
		}
		if refName == "" {
			if err := p.emitExpanded(out, text, refOffset); err != nil {
				return err
			}
		} else if builtin, ok := builtinEntity(refName); ok {
			if err := p.emitExpanded(out, builtin, refOffset); err != nil {
				return err
			}
		} else if _, ok := p.entities[refName]; ok {
			if err := p.expandEntity(refName, out, stack, refOffset); err != nil {
				return err
			}
		} else {
			return p.errf(ErrUndefinedEntity, refOffset, "entity %q is not declared", refName)
		}
		i = next
		literalStart = i
	}
	if literalStart < len(data) {
		if err := p.emitExpanded(out, string(data[literalStart:]), refOffset); err != nil {
			return err
		}
	}
	return nil
}

func (p *parser) emitExpanded(out *strings.Builder, text string, offset int) error {
	if text == "" {
		return nil
	}
	if err := validateXMLString(text); err != nil {
		return p.errf(ErrMalformed, offset, "%v", err)
	}
	if len(text) > p.max-p.expanded {
		return p.errf(ErrExpansionLimit, offset, "expanded entity text exceeds the %d-byte limit", p.max)
	}
	p.expanded += len(text)
	out.WriteString(text)
	return nil
}
