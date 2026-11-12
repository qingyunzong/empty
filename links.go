package dataeng

import (
	"html"
	"strings"
)

// extractLinks returns the href attribute values of anchor elements in document
// order. It is a small purpose-built scanner because the package only depends
// on the Go standard library: it skips comments, DOCTYPE, script and style
// content, tolerates malformed markup, and decodes HTML entities in values.
func extractLinks(document []byte) []string {
	tokenizer := newLinkTokenizer(document)
	var links []string
	for {
		tagName, attrs, end := tokenizer.next()
		if end {
			return links
		}
		if !strings.EqualFold(tagName, "a") {
			continue
		}
		for _, attr := range attrs {
			if strings.EqualFold(attr.name, "href") {
				links = append(links, html.UnescapeString(attr.value))
				break
			}
		}
	}
}

type htmlAttribute struct {
	name  string
	value string
}

type linkTokenizer struct {
	input []byte
	pos   int
}

func newLinkTokenizer(input []byte) *linkTokenizer {
	return &linkTokenizer{input: input}
}

// next returns the next start tag with its attributes, or end == true once the
// document is exhausted. End tags and text nodes are skipped; raw text inside
// script and style elements is skipped without tag scanning.
func (t *linkTokenizer) next() (tagName string, attrs []htmlAttribute, end bool) {
	for t.pos < len(t.input) {
		if t.input[t.pos] != '<' {
			t.pos++
			continue
		}

		mark := t.pos
		t.pos++
		if t.consumeComment() || t.consumeDoctype() || t.consumeDeclaration() {
			continue
		}
		if t.pos >= len(t.input) {
			break
		}

		closing := false
		if t.input[t.pos] == '/' {
			closing = true
			t.pos++
		}
		name, ok := t.consumeTagName()
		if !ok {
			// Not actually a tag; resume after the '<'.
			t.pos = mark + 1
			continue
		}

		attributes := t.consumeAttributes()
		t.skipToTagEnd()
		if closing {
			continue
		}
		if strings.EqualFold(name, "script") || strings.EqualFold(name, "style") {
			t.skipRawText(name)
			continue
		}
		return name, attributes, false
	}
	return "", nil, true
}

func (t *linkTokenizer) consumeComment() bool {
	if t.pos+4 > len(t.input) || string(t.input[t.pos:t.pos+4]) != "<!--" {
		return false
	}
	t.pos += 4
	for t.pos+2 < len(t.input) {
		if t.input[t.pos] == '-' && t.input[t.pos+1] == '-' && t.input[t.pos+2] == '>' {
			t.pos += 3
			return true
		}
		t.pos++
	}
	t.pos = len(t.input)
	return true
}

func (t *linkTokenizer) consumeDoctype() bool {
	if t.pos >= len(t.input) || t.input[t.pos] != '!' {
		return false
	}
	t.pos++
	start := t.pos
	for t.pos < len(t.input) && t.input[t.pos] != '>' && !isASCIIWhitespace(t.input[t.pos]) {
		t.pos++
	}
	if !strings.EqualFold(string(t.input[start:t.pos]), "DOCTYPE") {
		t.pos = start
		return false
	}
	t.skipToTagEnd()
	return true
}

func (t *linkTokenizer) consumeDeclaration() bool {
	if t.pos >= len(t.input) || t.input[t.pos] != '?' {
		return false
	}
	t.skipToTagEnd()
	return true
}

func (t *linkTokenizer) consumeTagName() (string, bool) {
	start := t.pos
	for t.pos < len(t.input) {
		ch := t.input[t.pos]
		if isASCIIWhitespace(ch) || ch == '>' || ch == '/' {
			break
		}
		t.pos++
	}
	return string(t.input[start:t.pos]), start < t.pos
}

func (t *linkTokenizer) consumeAttributes() []htmlAttribute {
	var attributes []htmlAttribute
	for {
		t.skipWhitespace()
		if t.pos >= len(t.input) || t.input[t.pos] == '>' || t.input[t.pos] == '/' {
			return attributes
		}
		name := t.consumeAttributeName()
		if name == "" {
			// Malformed attribute; advance to avoid an infinite loop.
			t.pos++
			continue
		}

		value := ""
		t.skipWhitespace()
		if t.pos < len(t.input) && t.input[t.pos] == '=' {
			t.pos++
			t.skipWhitespace()
			value = t.consumeAttributeValue()
		}
		attributes = append(attributes, htmlAttribute{name: name, value: value})
	}
}

func (t *linkTokenizer) consumeAttributeName() string {
	start := t.pos
	for t.pos < len(t.input) {
		ch := t.input[t.pos]
		if isASCIIWhitespace(ch) || ch == '>' || ch == '/' || ch == '=' {
			break
		}
		t.pos++
	}
	return string(t.input[start:t.pos])
}

func (t *linkTokenizer) consumeAttributeValue() string {
	if t.pos >= len(t.input) {
		return ""
	}
	quote := t.input[t.pos]
	if quote == '"' || quote == '\'' {
		t.pos++
		start := t.pos
		for t.pos < len(t.input) && t.input[t.pos] != quote {
			t.pos++
		}
		value := string(t.input[start:t.pos])
		if t.pos < len(t.input) {
			t.pos++
		}
		return value
	}

	start := t.pos
	for t.pos < len(t.input) {
		ch := t.input[t.pos]
		if isASCIIWhitespace(ch) || ch == '>' {
			break
		}
		t.pos++
	}
	return string(t.input[start:t.pos])
}

func (t *linkTokenizer) skipRawText(tagName string) {
	closing := []byte("</" + tagName)
	for t.pos < len(t.input) {
		next := indexFrom(t.input, closing, t.pos)
		if next < 0 {
			t.pos = len(t.input)
			return
		}
		after := next + len(closing)
		if after >= len(t.input) || isASCIIWhitespace(t.input[after]) || t.input[after] == '>' {
			t.pos = next
			return
		}
		t.pos = next + 1
	}
}

func (t *linkTokenizer) skipToTagEnd() {
	for t.pos < len(t.input) && t.input[t.pos] != '>' {
		t.pos++
	}
	if t.pos < len(t.input) {
		t.pos++
	}
}

func (t *linkTokenizer) skipWhitespace() {
	for t.pos < len(t.input) && isASCIIWhitespace(t.input[t.pos]) {
		t.pos++
	}
}

func indexFrom(input []byte, pattern []byte, start int) int {
	if start < 0 || start > len(input) || len(pattern) == 0 {
		return -1
	}
	limit := len(input) - len(pattern)
	for i := start; i <= limit; i++ {
		if string(input[i:i+len(pattern)]) == string(pattern) {
			return i
		}
	}
	return -1
}

func isASCIIWhitespace(ch byte) bool {
	switch ch {
	case ' ', '\t', '\n', '\r', '\f':
		return true
	default:
		return false
	}
}
