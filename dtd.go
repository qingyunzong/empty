package dataeng

import "strings"

func (p *parser) parseDoctype() error {
	start := p.pos
	p.pos += len("<!DOCTYPE")
	if p.eof() || !isXMLSpace(p.peek()) {
		return p.errf(ErrMalformed, start, "invalid DOCTYPE declaration")
	}
	p.skipSpaces()
	if _, err := p.scanName(); err != nil {
		return err
	}
	p.skipSpaces()

	if p.has("SYSTEM") || p.has("PUBLIC") {
		return p.errf(ErrExternalEntity, p.pos, "external DTD subsets are not allowed")
	}

	if !p.eof() && p.peek() == '[' {
		p.pos++
		if err := p.parseInternalSubset(); err != nil {
			return err
		}
		if p.eof() || p.peek() != ']' {
			return p.errf(ErrMalformed, p.pos, "unterminated internal DTD subset")
		}
		p.pos++
	}

	p.skipSpaces()
	if p.eof() || p.peek() != '>' {
		return p.errf(ErrMalformed, p.pos, "expected '>' at end of DOCTYPE")
	}
	p.pos++
	return nil
}

func (p *parser) parseInternalSubset() error {
	for {
		p.skipSpaces()
		if p.eof() {
			return p.errf(ErrMalformed, p.pos, "unterminated internal DTD subset")
		}
		if p.peek() == ']' {
			return nil
		}
		switch {
		case p.has("<!--"):
			if _, err := p.parseComment(); err != nil {
				return err
			}
		case p.has("<?"):
			if _, err := p.parsePI(); err != nil {
				return err
			}
		case p.hasDeclKeyword("<!ENTITY"):
			if err := p.parseEntityDecl(); err != nil {
				return err
			}
		case p.hasDeclKeyword("<!ELEMENT"), p.hasDeclKeyword("<!ATTLIST"), p.hasDeclKeyword("<!NOTATION"):
			if err := p.skipMarkupDeclaration(); err != nil {
				return err
			}
		case p.has("<!["):
			return p.errf(ErrUnsupported, p.pos, "conditional DTD sections are not supported")
		case p.peek() == '%':
			return p.errf(ErrUnsupported, p.pos, "parameter entity references are not supported")
		default:
			return p.errf(ErrMalformed, p.pos, "unexpected content in internal DTD subset")
		}
	}
}

func (p *parser) parseEntityDecl() error {
	start := p.pos
	p.pos += len("<!ENTITY")
	if p.eof() || !isXMLSpace(p.peek()) {
		return p.errf(ErrMalformed, start, "invalid ENTITY declaration")
	}
	p.skipSpaces()

	parameter := false
	if !p.eof() && p.peek() == '%' {
		parameter = true
		p.pos++
		p.skipSpaces()
	}
	name, err := p.scanName()
	if err != nil {
		return err
	}
	p.skipSpaces()

	if p.has("SYSTEM") || p.has("PUBLIC") {
		return p.errf(ErrExternalEntity, start, "entity %q has an external identifier", name)
	}
	if p.eof() || p.peek() != '"' && p.peek() != '\'' {
		return p.errf(ErrMalformed, p.pos, "expected quoted entity value")
	}
	value, err := p.readQuotedValue()
	if err != nil {
		return err
	}
	p.skipSpaces()

	if parameter {
		return p.errf(ErrUnsupported, start, "parameter entity %q is not supported", name)
	}
	if p.hasKeyword("NDATA") {
		return p.errf(ErrExternalEntity, start, "unparsed entity %q is not allowed", name)
	}
	if p.eof() || p.peek() != '>' {
		return p.errf(ErrMalformed, p.pos, "expected '>' at end of ENTITY declaration")
	}
	p.pos++

	if _, exists := p.entities[name]; exists {
		return p.errf(ErrMalformed, start, "duplicate entity declaration %q", name)
	}
	p.entities[name] = value
	return nil
}

func (p *parser) readQuotedValue() (string, error) {
	start := p.pos
	quote := p.peek()
	p.pos++
	valueStart := p.pos
	for !p.eof() && p.peek() != quote {
		p.pos++
	}
	if p.eof() {
		return "", p.errf(ErrMalformed, start, "unterminated entity value")
	}
	value := normalizeLineEndings(string(p.src[valueStart:p.pos]))
	p.pos++
	if err := validateXMLString(value); err != nil {
		return "", p.errf(ErrMalformed, start, "%v", err)
	}
	if strings.ContainsRune(value, '%') {
		return "", p.errf(ErrUnsupported, start, "parameter entity references are not supported")
	}
	if strings.ContainsRune(value, '<') {
		return "", p.errf(ErrUnsupported, start, "markup inside entity values is not supported")
	}
	return value, nil
}

func (p *parser) skipMarkupDeclaration() error {
	start := p.pos
	p.pos += len("<!")
	for !p.eof() {
		switch p.peek() {
		case '"', '\'':
			quote := p.peek()
			p.pos++
			for !p.eof() && p.peek() != quote {
				p.pos++
			}
			if p.eof() {
				return p.errf(ErrMalformed, start, "unterminated markup declaration")
			}
			p.pos++
		case '>':
			p.pos++
			return nil
		case '[':
			return p.errf(ErrUnsupported, start, "conditional DTD sections are not supported")
		default:
			p.pos++
		}
	}
	return p.errf(ErrMalformed, start, "unterminated markup declaration")
}

func (p *parser) hasKeyword(keyword string) bool {
	if !p.has(keyword) {
		return false
	}
	end := p.pos + len(keyword)
	if end >= len(p.src) {
		return true
	}
	b := p.src[end]
	return isXMLSpace(b) || b == '"' || b == '\''
}

func (p *parser) hasDeclKeyword(keyword string) bool {
	if !p.has(keyword) {
		return false
	}
	end := p.pos + len(keyword)
	if end >= len(p.src) {
		return true
	}
	b := p.src[end]
	return isXMLSpace(b) || b == '%'
}
