package dataeng

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"unicode"
)

const (
	xmlNamespaceURI   = "http://www.w3.org/XML/1998/namespace"
	xmlnsNamespaceURI = "http://www.w3.org/2000/xmlns/"
)

type rawAttribute struct {
	qname       string
	prefix      string
	local       string
	value       string
	rawValue    string
	offset      int64
	endOffset   int64
	valueOffset int64
}

type rawStartTag struct {
	qname       string
	prefix      string
	local       string
	attrs       []rawAttribute
	selfClosing bool
	offset      int64
	endOffset   int64
}

type rawEndTag struct {
	qname     string
	prefix    string
	local     string
	offset    int64
	endOffset int64
}

type nsScope struct {
	parent     *nsScope
	decls      map[string]string
	defaultSet bool
	defaultURI string
	baseURI    string
}

func (s *nsScope) lookup(prefix string) (string, bool) {
	if prefix == "xml" {
		return xmlNamespaceURI, true
	}
	for cur := s; cur != nil; cur = cur.parent {
		uri, ok := cur.decls[prefix]
		if ok {
			if uri == "" {
				return "", false
			}
			return uri, true
		}
	}
	return "", false
}

func (s *nsScope) defaultNamespace() string {
	if s == nil {
		return ""
	}
	return s.defaultURI
}

func (s *nsScope) resolvePrefix(prefix string) (string, bool) {
	switch prefix {
	case "":
		return s.defaultNamespace(), true
	case "xml":
		return xmlNamespaceURI, true
	case "xmlns":
		return "", false
	default:
		return s.lookup(prefix)
	}
}

func (s *nsScope) snapshot() map[string]string {
	if s == nil {
		return map[string]string{"xml": xmlNamespaceURI}
	}
	out := s.parent.snapshot()
	for prefix, uri := range s.decls {
		if uri == "" {
			delete(out, prefix)
			continue
		}
		out[prefix] = uri
	}
	if s.defaultSet {
		if s.defaultURI == "" {
			delete(out, "")
		} else {
			out[""] = s.defaultURI
		}
	}
	return out
}

func splitQName(qname string) (prefix, local string, err error) {
	if qname == "" {
		return "", "", fmt.Errorf("empty XML name")
	}
	if strings.Count(qname, ":") > 1 {
		return "", "", fmt.Errorf("invalid qualified name %q", qname)
	}
	prefix, local, found := strings.Cut(qname, ":")
	if !found {
		return "", qname, nil
	}
	if prefix == "" || local == "" {
		return "", "", fmt.Errorf("invalid qualified name %q", qname)
	}
	return prefix, local, nil
}

func isXMLSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\r' || b == '\n'
}

func isNameEnd(b byte) bool {
	return isXMLSpace(b) || b == '/' || b == '>' || b == '=' || b == '?'
}

func scanRawName(raw []byte, i int) (string, int, error) {
	start := i
	for i < len(raw) && !isNameEnd(raw[i]) {
		i++
	}
	if i == start {
		return "", i, fmt.Errorf("missing XML name")
	}
	return string(raw[start:i]), i, nil
}

func parseRawStartTag(raw []byte, offset int64) (rawStartTag, error) {
	var tag rawStartTag
	tag.offset = offset
	tag.endOffset = offset + int64(len(raw))
	if len(raw) < 3 || raw[0] != '<' {
		return tag, fmt.Errorf("invalid start tag")
	}

	i := 1
	qname, next, err := scanRawName(raw, i)
	if err != nil {
		return tag, err
	}
	tag.qname = qname
	i = next
	tag.prefix, tag.local, err = splitQName(qname)
	if err != nil {
		return tag, err
	}

	for {
		for i < len(raw) && isXMLSpace(raw[i]) {
			i++
		}
		if i >= len(raw) {
			return tag, fmt.Errorf("unterminated start tag")
		}
		if raw[i] == '>' {
			i++
			if i != len(raw) {
				return tag, fmt.Errorf("unexpected data in start tag")
			}
			return tag, nil
		}
		if raw[i] == '/' {
			if i+1 >= len(raw) || raw[i+1] != '>' {
				return tag, fmt.Errorf("invalid self-closing tag")
			}
			tag.selfClosing = true
			i += 2
			if i != len(raw) {
				return tag, fmt.Errorf("unexpected data in start tag")
			}
			return tag, nil
		}

		attrOffset := offset + int64(i)
		attrQName, next, err := scanRawName(raw, i)
		if err != nil {
			return tag, err
		}
		i = next
		for i < len(raw) && isXMLSpace(raw[i]) {
			i++
		}
		if i >= len(raw) || raw[i] != '=' {
			return tag, fmt.Errorf("attribute %q has no value", attrQName)
		}
		i++
		for i < len(raw) && isXMLSpace(raw[i]) {
			i++
		}
		if i >= len(raw) || (raw[i] != '\'' && raw[i] != '"') {
			return tag, fmt.Errorf("attribute %q is not quoted", attrQName)
		}
		quote := raw[i]
		i++
		valueStart := i
		for i < len(raw) && raw[i] != quote {
			i++
		}
		if i >= len(raw) {
			return tag, fmt.Errorf("unterminated attribute %q", attrQName)
		}
		rawValue := string(raw[valueStart:i])
		value, err := decodeXMLValue([]byte(rawValue))
		if err != nil {
			return tag, err
		}
		i++
		attr := rawAttribute{
			qname:       attrQName,
			rawValue:    rawValue,
			value:       value,
			offset:      attrOffset,
			endOffset:   offset + int64(i),
			valueOffset: offset + int64(valueStart),
		}
		attr.prefix, attr.local, err = splitQName(attrQName)
		if err != nil {
			return tag, err
		}
		tag.attrs = append(tag.attrs, attr)
	}
}

func parseRawEndTag(raw []byte, offset int64) (rawEndTag, error) {
	var tag rawEndTag
	tag.offset = offset
	tag.endOffset = offset + int64(len(raw))
	if len(raw) < 4 || raw[0] != '<' || raw[1] != '/' {
		return tag, fmt.Errorf("invalid end tag")
	}
	qname, i, err := scanRawName(raw, 2)
	if err != nil {
		return tag, err
	}
	tag.qname = qname
	tag.prefix, tag.local, err = splitQName(qname)
	if err != nil {
		return tag, err
	}
	for i < len(raw) && isXMLSpace(raw[i]) {
		i++
	}
	if i >= len(raw) || raw[i] != '>' || i+1 != len(raw) {
		return tag, fmt.Errorf("invalid end tag")
	}
	return tag, nil
}

func decodeXMLValue(raw []byte) (string, error) {
	var b strings.Builder
	for i := 0; i < len(raw); {
		c := raw[i]
		if c == '\r' {
			b.WriteByte('\n')
			i++
			if i < len(raw) && raw[i] == '\n' {
				i++
			}
			continue
		}
		if c != '&' {
			b.WriteByte(c)
			i++
			continue
		}

		end := -1
		for j := i + 1; j < len(raw); j++ {
			if raw[j] == ';' {
				end = j
				break
			}
		}
		if end < 0 {
			return "", fmt.Errorf("%w: entity without semicolon", ErrUnknownEntity)
		}
		name := string(raw[i+1 : end])
		switch name {
		case "lt":
			b.WriteByte('<')
		case "gt":
			b.WriteByte('>')
		case "amp":
			b.WriteByte('&')
		case "apos":
			b.WriteByte('\'')
		case "quot":
			b.WriteByte('"')
		default:
			if strings.HasPrefix(name, "#") {
				base := 10
				digits := name[1:]
				if strings.HasPrefix(digits, "x") || strings.HasPrefix(digits, "X") {
					base = 16
					digits = digits[1:]
				}
				if digits == "" {
					return "", fmt.Errorf("%w: %q", ErrUnknownEntity, name)
				}
				n, err := strconv.ParseUint(digits, base, 32)
				if err != nil || n > unicode.MaxRune {
					return "", fmt.Errorf("%w: %q", ErrUnknownEntity, name)
				}
				b.WriteRune(rune(n))
			} else {
				return "", fmt.Errorf("%w: %q", ErrUnknownEntity, name)
			}
		}
		i = end + 1
	}
	return b.String(), nil
}

func validateNamespaceDecl(prefix, uri string) error {
	if uri == xmlnsNamespaceURI {
		return fmt.Errorf("%w: the xmlns namespace cannot be bound", ErrInvalidNamespace)
	}
	if prefix == "xmlns" {
		return fmt.Errorf("%w: the xmlns prefix is reserved", ErrInvalidNamespace)
	}
	if prefix == "xml" {
		if uri != xmlNamespaceURI {
			return fmt.Errorf("%w: xml prefix must be bound to %q", ErrInvalidNamespace, xmlNamespaceURI)
		}
		return nil
	}
	if uri == xmlNamespaceURI {
		return fmt.Errorf("%w: only the xml prefix may be bound to %q", ErrInvalidNamespace, xmlNamespaceURI)
	}
	return nil
}

func resolveBaseURI(parent, reference string) (string, error) {
	if reference == "" {
		if i := strings.IndexByte(parent, '#'); i >= 0 {
			return parent[:i], nil
		}
		return parent, nil
	}
	if parent == "" {
		if _, err := url.Parse(reference); err != nil {
			return "", fmt.Errorf("%w: %q", ErrInvalidXMLBase, reference)
		}
		return reference, nil
	}
	base, err := url.Parse(parent)
	if err != nil {
		return "", fmt.Errorf("%w: %q", ErrInvalidXMLBase, parent)
	}
	ref, err := url.Parse(reference)
	if err != nil {
		return "", fmt.Errorf("%w: %q", ErrInvalidXMLBase, reference)
	}
	return base.ResolveReference(ref).String(), nil
}
