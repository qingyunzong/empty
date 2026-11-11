package q225

// beginChunk parses one chunk-size line (without its CRLF). The size is one
// or more hex digits; an empty size or a non-hex digit is rejected. Chunk
// extensions after the first semicolon are parsed as token or quoted-string
// parameters and validated, then discarded. A zero chunk moves the parser
// into the trailing section.
func (d *Decoder) beginChunk(line []byte) error {
	semi := indexUnquotedSemicolon(line)
	sizeToken := line
	if semi >= 0 {
		sizeToken = line[:semi]
		if err := parseChunkExtensions(line[semi:]); err != nil {
			return err
		}
	}

	if len(sizeToken) == 0 {
		return ErrChunkSyntax
	}
	size, ok := parseHexSize(sizeToken)
	if !ok {
		return ErrChunkSyntax
	}

	if size == 0 {
		d.state = stateTrailer
		return nil
	}
	d.remaining = size
	d.state = stateChunkData
	return nil
}

// indexUnquotedSemicolon returns the index of the first semicolon that
// appears outside a quoted-string, or -1. A quote can only start inside an
// extension section, so the chunk-size token itself never hides a
// semicolon.
func indexUnquotedSemicolon(line []byte) int {
	quoted := false
	for i := 0; i < len(line); i++ {
		switch line[i] {
		case '"':
			quoted = !quoted
		case ';':
			if !quoted {
				return i
			}
		}
	}
	return -1
}

// parseHexSize parses one or more hex digits, rejecting overflow against
// the platform int range.
func parseHexSize(token []byte) (int64, bool) {
	var size int64
	for i := 0; i < len(token); i++ {
		var digit int64
		switch {
		case token[i] >= '0' && token[i] <= '9':
			digit = int64(token[i] - '0')
		case token[i] >= 'a' && token[i] <= 'f':
			digit = int64(token[i]-'a') + 10
		case token[i] >= 'A' && token[i] <= 'F':
			digit = int64(token[i]-'A') + 10
		default:
			return 0, false
		}
		if size > (1<<63-1-digit)/16 {
			return 0, false
		}
		size = size*16 + digit
	}
	return size, true
}

// parseChunkExtensions validates chunk extensions in the form
//
//	;name;name=token;name="quoted string"
//
// Semicolons inside quoted strings do not separate parameters, and a
// backslash only escapes the next byte within a quoted string.
func parseChunkExtensions(ext []byte) error {
	for len(ext) > 0 {
		if ext[0] != ';' {
			return ErrChunkSyntax
		}
		ext = ext[1:]
		_, rest, ok := readToken(ext)
		if !ok {
			return ErrChunkSyntax
		}
		ext = rest
		if len(ext) > 0 && ext[0] == '=' {
			ext = ext[1:]
			if len(ext) == 0 {
				return ErrChunkSyntax
			}
			if ext[0] == '"' {
				_, rest, ok := readQuoted(ext)
				if !ok {
					return ErrChunkSyntax
				}
				ext = rest
			} else {
				_, rest, ok := readToken(ext)
				if !ok {
					return ErrChunkSyntax
				}
				ext = rest
			}
			// A value must run to the next parameter separator; trailing
			// junk such as `"x"y` or `tok en` is not a valid extension.
			if len(ext) > 0 && ext[0] != ';' {
				return ErrChunkSyntax
			}
		}
	}
	return nil
}

func readToken(p []byte) (token, rest []byte, ok bool) {
	i := 0
	for i < len(p) && isTokenChar(p[i]) {
		i++
	}
	if i == 0 {
		return nil, p, false
	}
	return p[:i], p[i:], true
}

// readQuoted consumes a quoted-string starting at p[0] == '"'. Quoted-pair
// backslashes are honored; bare CR/LF and unescaped control bytes are
// rejected.
func readQuoted(p []byte) (value, rest []byte, ok bool) {
	if len(p) < 2 || p[0] != '"' {
		return nil, p, false
	}
	i := 1
	for i < len(p) {
		c := p[i]
		switch {
		case c == '"':
			return p[1:i], p[i+1:], true
		case c == '\\':
			if i+1 >= len(p) {
				return nil, p, false
			}
			i += 2
		case c == '\r' || c == '\n' || c < 0x20:
			return nil, p, false
		default:
			i++
		}
	}
	return nil, p, false
}

// isTokenChar implements the RFC 9110 tchar set.
func isTokenChar(c byte) bool {
	switch c {
	case '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~':
		return true
	}
	return (c >= 'a' && c <= 'z') ||
		(c >= 'A' && c <= 'Z') ||
		(c >= '0' && c <= '9')
}

// forbiddenTrailers lists field names that must never appear in the
// trailing section (RFC 9112 6.4.2 plus the framing and routing headers).
var forbiddenTrailers = map[string]struct{}{
	canonicalKey("Content-Length"):    {},
	canonicalKey("Transfer-Encoding"): {},
	canonicalKey("Host"):              {},
	canonicalKey("Trailer"):           {},
}

// addTrailer parses and stores one trailer field line. It rejects obsolete
// line folding, lines without a colon, invalid field names, control bytes
// in the value, forbidden names and the field-count limit.
func (d *Decoder) addTrailer(line []byte) error {
	if line[0] == ' ' || line[0] == '\t' {
		return ErrTrailerSyntax
	}
	colon := -1
	for i, c := range line {
		if c == ':' {
			colon = i
			break
		}
	}
	if colon <= 0 {
		return ErrTrailerSyntax
	}

	name := line[:colon]
	for _, c := range name {
		if !isTokenChar(c) {
			return ErrTrailerSyntax
		}
	}

	value := line[colon+1:]
	// OWS before the value is trimmed; trailing OWS and the value itself
	// are checked for legal field-content bytes.
	for len(value) > 0 && (value[0] == ' ' || value[0] == '\t') {
		value = value[1:]
	}
	for len(value) > 0 && (value[len(value)-1] == ' ' || value[len(value)-1] == '\t') {
		value = value[:len(value)-1]
	}
	for _, c := range value {
		if (c < 0x20 && c != '\t') || c == 0x7f {
			return ErrTrailerSyntax
		}
	}

	key := canonicalKey(string(name))
	if _, banned := forbiddenTrailers[key]; banned {
		return ErrForbiddenTrailer
	}
	if len(d.trailers) >= d.limits.MaxTrailerFields && d.trailers[key] == nil {
		return ErrTrailerTooLarge
	}
	d.trailers[key] = append(d.trailers[key], string(value))
	return nil
}
