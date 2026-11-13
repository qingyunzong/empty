package dataeng

import (
	"bytes"
	"strings"
)

// scanMetaCharset returns the first charset declared by a meta element in the
// sniff window. The second result reports that an incomplete sample ended in
// the middle of a possible meta tag, making the answer undecided. Meta text
// inside comments and script/style raw-text elements is ignored.
func scanMetaCharset(sample []byte, complete bool) (string, bool) {
	limit := len(sample)
	if limit > SniffLimit {
		limit = SniffLimit
	}
	buf := sample[:limit]

	for pos := 0; pos < limit; {
		relative := bytes.IndexByte(buf[pos:], '<')
		if relative < 0 {
			break
		}
		start := pos + relative
		rest := buf[start:]

		if len(rest) >= 4 && bytes.Equal(rest[:4], []byte("<!--")) {
			end := bytes.Index(buf[start+4:], []byte("-->"))
			if end < 0 {
				break
			}
			pos = start + 4 + end + len("-->")
			continue
		}

		if len(rest) >= 2 && (rest[1] == '!' || rest[1] == '?') {
			end := findTagEnd(buf, start+1)
			if end < 0 {
				break
			}
			pos = end + 1
			continue
		}

		if len(rest) >= 2 && rest[1] == '/' {
			end := findTagEnd(buf, start+1)
			if end < 0 {
				break
			}
			pos = end + 1
			continue
		}

		if start+1 >= limit {
			// A lone '<' is too weak to call a truncated meta declaration.
			break
		}
		if !isASCIILetter(rest[1]) {
			pos = start + 1
			continue
		}

		nameEnd := start + 1
		for nameEnd < limit && isTagNameByte(buf[nameEnd]) {
			nameEnd++
		}
		name := strings.ToLower(string(buf[start+1 : nameEnd]))

		if nameEnd == limit {
			if !complete && len(name) > 0 && strings.HasPrefix("meta", name) {
				return "", true
			}
			break
		}

		tagEnd := findTagEnd(buf, nameEnd)
		if tagEnd < 0 {
			if !complete && name == "meta" {
				return "", true
			}
			break
		}

		switch name {
		case "meta":
			if label := parseMetaCharset(buf, nameEnd, tagEnd); label != "" {
				return label, false
			}
			pos = tagEnd + 1
		case "script", "style":
			contentStart := tagEnd + 1
			closeStart := findRawClose(buf, contentStart, name)
			if closeStart < 0 {
				// Everything left is raw text, so it cannot contain a
				// declaration that is outside the element.
				pos = limit
				continue
			}
			closeEnd := findTagEnd(buf, closeStart+len(name)+2)
			if closeEnd < 0 {
				pos = limit
				continue
			}
			pos = closeEnd + 1
		default:
			pos = tagEnd + 1
		}
	}

	return "", false
}

func findTagEnd(buf []byte, start int) int {
	var quote byte
	for index := start; index < len(buf); index++ {
		switch buf[index] {
		case '"', '\'':
			if quote == 0 {
				quote = buf[index]
			} else if quote == buf[index] {
				quote = 0
			}
		case '>':
			if quote == 0 {
				return index
			}
		}
	}
	return -1
}

func findRawClose(buf []byte, start int, name string) int {
	for start < len(buf) {
		relative := bytes.IndexByte(buf[start:], '<')
		if relative < 0 {
			return -1
		}
		index := start + relative
		if index+2+len(name) > len(buf) || buf[index+1] != '/' {
			start = index + 1
			continue
		}
		if !bytes.EqualFold(buf[index+2:index+2+len(name)], []byte(name)) {
			start = index + 1
			continue
		}
		after := index + 2 + len(name)
		if after == len(buf) || isTagNameEnd(buf[after]) {
			return index
		}
		start = index + 1
	}
	return -1
}

type metaAttr struct {
	name       string
	value      string
	valueStart int
}

func parseMetaCharset(buf []byte, start, end int) string {
	attrs := parseTagAttrs(buf, start, end)

	var httpEquiv, content string
	for _, attr := range attrs {
		switch attr.name {
		case "charset":
			if value := cleanMetaLabel(attr.value); value != "" {
				return value
			}
		case "http-equiv":
			if httpEquiv == "" {
				httpEquiv = strings.TrimSpace(attr.value)
			}
		case "content":
			if content == "" {
				content = attr.value
			}
		}
	}

	if content == "" {
		return ""
	}
	if httpEquiv != "" && !strings.EqualFold(strings.TrimSpace(httpEquiv), "content-type") {
		return ""
	}
	if httpEquiv == "" && !strings.Contains(strings.ToLower(content), "text/html") {
		return ""
	}
	return charsetFromContent(content)
}

func parseTagAttrs(buf []byte, start, end int) []metaAttr {
	var attrs []metaAttr
	for pos := start; pos < end; {
		for pos < end && isHTMLSpace(buf[pos]) {
			pos++
		}
		if pos >= end {
			break
		}
		if buf[pos] == '/' {
			pos++
			continue
		}

		nameStart := pos
		for pos < end && !isHTMLSpace(buf[pos]) && buf[pos] != '=' &&
			buf[pos] != '/' && buf[pos] != '>' {
			pos++
		}
		name := strings.ToLower(string(buf[nameStart:pos]))
		if name == "" {
			pos++
			continue
		}

		for pos < end && isHTMLSpace(buf[pos]) {
			pos++
		}
		attr := metaAttr{name: name}
		if pos < end && buf[pos] == '=' {
			pos++
			for pos < end && isHTMLSpace(buf[pos]) {
				pos++
			}
			attr.valueStart = pos
			if pos < end && (buf[pos] == '"' || buf[pos] == '\'') {
				quote := buf[pos]
				pos++
				attr.valueStart = pos
				for pos < end && buf[pos] != quote {
					pos++
				}
				if pos >= end {
					// An unterminated quoted value is not a usable
					// declaration.
					break
				}
				attr.value = string(buf[attr.valueStart:pos])
				pos++
			} else {
				for pos < end && !isHTMLSpace(buf[pos]) && buf[pos] != '>' {
					pos++
				}
				attr.value = string(buf[attr.valueStart:pos])
			}
		}
		attrs = append(attrs, attr)
	}
	return attrs
}

func cleanMetaLabel(value string) string {
	value = strings.TrimSpace(value)
	value = strings.Trim(value, `"'`)
	if index := strings.IndexAny(value, " \t\r\n;"); index >= 0 {
		value = value[:index]
	}
	value = strings.TrimSuffix(strings.TrimSpace(value), "/")
	return strings.TrimSpace(value)
}

func charsetFromContent(content string) string {
	lower := strings.ToLower(content)
	for offset := 0; offset < len(lower); {
		index := strings.Index(lower[offset:], "charset")
		if index < 0 {
			return ""
		}
		index += offset
		if index > 0 && (isASCIILetter(lower[index-1]) || isASCIIDigit(lower[index-1]) ||
			lower[index-1] == '-' || lower[index-1] == '_') {
			offset = index + len("charset")
			continue
		}
		pos := index + len("charset")
		for pos < len(content) && isHTMLSpace(content[pos]) {
			pos++
		}
		if pos >= len(content) || content[pos] != '=' {
			offset = pos
			continue
		}
		pos++
		for pos < len(content) && isHTMLSpace(content[pos]) {
			pos++
		}
		if pos >= len(content) {
			return ""
		}
		if content[pos] == '"' || content[pos] == '\'' {
			pos++
		}
		valueStart := pos
		for pos < len(content) && !isHTMLSpace(content[pos]) &&
			content[pos] != ';' && content[pos] != '"' && content[pos] != '\'' {
			pos++
		}
		if value := cleanMetaLabel(content[valueStart:pos]); value != "" {
			return value
		}
		offset = pos
	}
	return ""
}

func isHTMLSpace(value byte) bool {
	switch value {
	case ' ', '\t', '\n', '\r', '\f':
		return true
	default:
		return false
	}
}

func isASCIILetter(value byte) bool {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z'
}

func isASCIIDigit(value byte) bool {
	return value >= '0' && value <= '9'
}

func isTagNameByte(value byte) bool {
	return isASCIILetter(value) || isASCIIDigit(value) ||
		value == '-' || value == '_' || value == ':' || value == '.'
}

func isTagNameEnd(value byte) bool {
	return isHTMLSpace(value) || value == '/' || value == '>'
}
