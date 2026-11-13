package dataeng

import "strings"

// CanonicalPath returns a conservative identity key for an Iceberg file path.
//
// The canonical form is intentionally conservative. It only applies
// equivalence-preserving URI normalization:
//
//   - the scheme and host of an absolute URI with an authority are lower-cased
//     (hosts and schemes are case-insensitive);
//   - percent escapes for unreserved characters are decoded, and the remaining
//     escapes are upper-cased (RFC 3986 section 6.2.2).
//
// Everything else is preserved byte-for-byte, including path case, trailing
// slashes, repeated slashes, dot segments, empty authority, query, and
// fragment. That means object-store keys that differ only by one of those
// properties remain distinct. Plain (non-URI) paths are returned unchanged.
//
// Two distinct objects must never collapse to the same key. The converse is
// not guaranteed: equivalent but unusual spellings may remain distinct. This
// trade-off is deliberate for a read layer, where losing a file is worse than
// treating two spellings as separate objects.
func CanonicalPath(path string) string {
	if path == "" {
		return ""
	}

	colon := strings.IndexByte(path, ':')
	if colon <= 0 {
		return path
	}
	scheme := path[:colon]
	if !validScheme(scheme) {
		return path
	}
	// A single-letter "scheme" is a Windows drive letter, not a URI scheme.
	if len(scheme) == 1 {
		return path
	}
	rest := path[colon+1:]
	// Only treat the input as a URI when it has an authority ("scheme://").
	// Without that marker a colon is just a legal filename byte on many
	// filesystems, and normalizing "FOO:bar" to "foo:bar" could merge two
	// distinct local files.
	if !strings.HasPrefix(rest, "//") {
		return path
	}

	var b strings.Builder
	b.Grow(len(path))
	b.WriteString(strings.ToLower(scheme))
	b.WriteByte(':')

	if strings.HasPrefix(rest, "//") {
		body := rest[2:]
		end := len(body)
		for i := 0; i < len(body); i++ {
			if body[i] == '/' || body[i] == '?' || body[i] == '#' {
				end = i
				break
			}
		}
		authority := body[:end]
		b.WriteString("//")
		b.WriteString(canonicalAuthority(authority))
		rest = body[end:]
	}

	pathEnd := len(rest)
	for i := 0; i < len(rest); i++ {
		if rest[i] == '?' || rest[i] == '#' {
			pathEnd = i
			break
		}
	}
	b.WriteString(normalizePctEscapes(rest[:pathEnd]))
	rest = rest[pathEnd:]

	if len(rest) > 0 && rest[0] == '?' {
		rest = rest[1:]
		queryEnd := len(rest)
		for i := 0; i < len(rest); i++ {
			if rest[i] == '#' {
				queryEnd = i
				break
			}
		}
		b.WriteByte('?')
		b.WriteString(normalizePctEscapes(rest[:queryEnd]))
		rest = rest[queryEnd:]
	}
	if len(rest) > 0 && rest[0] == '#' {
		b.WriteByte('#')
		b.WriteString(normalizePctEscapes(rest[1:]))
	}

	return b.String()
}

// PathsEqual reports whether two paths identify the same object according to
// CanonicalPath.
func PathsEqual(a, b string) bool {
	return CanonicalPath(a) == CanonicalPath(b)
}

func validScheme(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z':
		case c >= 'A' && c <= 'Z':
		case i > 0 && c >= '0' && c <= '9':
		case i > 0 && (c == '+' || c == '-' || c == '.'):
		default:
			return false
		}
	}
	return true
}

func canonicalAuthority(authority string) string {
	if authority == "" {
		return ""
	}

	at := strings.LastIndexByte(authority, '@')
	userinfo, hostport := "", authority
	if at >= 0 {
		userinfo = authority[:at+1]
		hostport = authority[at+1:]
	}

	host, port := hostport, ""
	if strings.HasPrefix(hostport, "[") {
		// IPv6 literal; the closing bracket terminates the host.
		if end := strings.IndexByte(hostport, ']'); end >= 0 {
			host = hostport[:end+1]
			if len(hostport) > end+1 && hostport[end+1] == ':' {
				port = hostport[end+1:]
			}
		}
	} else if colon := strings.LastIndexByte(hostport, ':'); colon >= 0 {
		host = hostport[:colon]
		port = hostport[colon:]
	}

	return userinfo + lowerHost(host) + port
}

func lowerHost(host string) string {
	// IPv6 zone identifiers are case-sensitive even though the address part is
	// not. Preserve the zone suffix exactly.
	if zone := strings.LastIndexByte(host, '%'); zone >= 0 {
		return strings.ToLower(host[:zone]) + host[zone:]
	}
	return strings.ToLower(host)
}

// normalizePctEscapes performs RFC 3986 percent-encoding normalization without
// changing the decoded identity of the path. Unreserved escapes are decoded;
// all other escapes are kept and upper-cased. Invalid escapes are left alone.
func normalizePctEscapes(s string) string {
	if !strings.ContainsRune(s, '%') {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if s[i] != '%' || i+2 >= len(s) {
			b.WriteByte(s[i])
			continue
		}
		hi, ok1 := hexValue(s[i+1])
		lo, ok2 := hexValue(s[i+2])
		if !ok1 || !ok2 {
			b.WriteByte(s[i])
			continue
		}
		v := hi<<4 | lo
		if isUnreserved(v) {
			b.WriteByte(v)
		} else {
			b.WriteByte('%')
			b.WriteByte(upperHex(hi))
			b.WriteByte(upperHex(lo))
		}
		i += 2
	}
	return b.String()
}

func hexValue(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	default:
		return 0, false
	}
}

func upperHex(v byte) byte {
	if v < 10 {
		return '0' + v
	}
	return 'A' + v - 10
}

func isUnreserved(v byte) bool {
	switch {
	case v >= 'a' && v <= 'z':
		return true
	case v >= 'A' && v <= 'Z':
		return true
	case v >= '0' && v <= '9':
		return true
	case v == '-', v == '.', v == '_', v == '~':
		return true
	default:
		return false
	}
}
