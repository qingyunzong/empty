package dataeng

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// NormalizeURL canonicalizes an absolute URL.
func NormalizeURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fmt.Errorf("%w: empty", ErrInvalidURL)
	}
	u, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidURL, err)
	}
	return canonicalizeURL(u)
}

// NormalizeURLWithBase resolves raw against base (when raw is relative) and
// then canonicalizes the result. A sitemap's own URL is normally used as the
// base, which makes "<loc>/news/1</loc>" work as producers expect.
func NormalizeURLWithBase(raw, base string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fmt.Errorf("%w: empty", ErrInvalidURL)
	}
	ref, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidURL, err)
	}
	if base == "" {
		return canonicalizeURL(ref)
	}
	baseURL, err := url.Parse(strings.TrimSpace(base))
	if err != nil {
		return "", fmt.Errorf("%w: base %q: %v", ErrInvalidURL, base, err)
	}
	if !ref.IsAbs() {
		ref = baseURL.ResolveReference(ref)
	}
	return canonicalizeURL(ref)
}

// CanonicalizeURL is an alias for NormalizeURL.
func CanonicalizeURL(raw string) (string, error) { return NormalizeURL(raw) }

// CanonicalURL is an alias for NormalizeURL.
func CanonicalURL(raw string) (string, error) { return NormalizeURL(raw) }

// CanonicalHost is an alias for NormalizeHost.
func CanonicalHost(raw string) string { return NormalizeHost(raw) }

// HostKey returns the canonical host (including a non-default port) for a URL.
// It returns an empty string when raw cannot be normalized.
func HostKey(raw string) string {
	normalized, err := NormalizeURL(raw)
	if err != nil {
		return ""
	}
	u, err := url.Parse(normalized)
	if err != nil {
		return ""
	}
	return u.Host
}

// NormalizeHost lower-cases a host and removes a trailing DNS root dot. A
// default HTTP port is removed when it can be inferred.
func NormalizeHost(raw string) string {
	value := strings.TrimSpace(strings.ToLower(raw))
	if value == "" {
		return ""
	}
	u, err := url.Parse("http://" + value)
	if err == nil && u.Hostname() != "" {
		host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
		port := u.Port()
		if port != "" {
			if n, err := strconv.Atoi(port); err == nil {
				if n == 80 {
					port = ""
				} else {
					port = strconv.Itoa(n)
				}
			}
		}
		return joinHostPort(host, port)
	}
	return strings.TrimSuffix(value, ".")
}

func canonicalizeURL(u *url.URL) (string, error) {
	if u == nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("%w: absolute URL with host required", ErrInvalidURL)
	}
	if u.Opaque != "" {
		return "", fmt.Errorf("%w: opaque URL not supported", ErrInvalidURL)
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" {
		return "", fmt.Errorf("%w: empty host", ErrInvalidURL)
	}
	port := u.Port()
	if port != "" {
		portNumber, err := strconv.Atoi(port)
		if err != nil {
			return "", fmt.Errorf("%w: invalid port %q", ErrInvalidURL, port)
		}
		if (scheme == "http" && portNumber == 80) || (scheme == "https" && portNumber == 443) {
			port = ""
		} else {
			port = strconv.Itoa(portNumber)
		}
	}

	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	path = removeDotSegments(normalizePercentEncoding(path))

	query := normalizePercentEncoding(u.RawQuery)

	var b strings.Builder
	b.Grow(len(scheme) + len(host) + len(path) + len(query) + 16)
	b.WriteString(scheme)
	b.WriteString("://")
	if u.User != nil {
		b.WriteString(u.User.String())
		b.WriteByte('@')
	}
	b.WriteString(joinHostPort(host, port))
	b.WriteString(path)
	if query != "" {
		b.WriteByte('?')
		b.WriteString(query)
	}
	return b.String(), nil
}

func joinHostPort(host, port string) string {
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	if port == "" {
		return host
	}
	return host + ":" + port
}

func removeDotSegments(path string) string {
	if path == "" {
		return "/"
	}
	absolute := strings.HasPrefix(path, "/")
	trailing := strings.HasSuffix(path, "/") ||
		strings.HasSuffix(path, "/.") || strings.HasSuffix(path, "/..") ||
		path == "." || path == ".."
	segments := strings.Split(path, "/")
	out := make([]string, 0, len(segments))
	for i, segment := range segments {
		if i == 0 && absolute && segment == "" {
			out = append(out, "")
			continue
		}
		switch segment {
		case ".":
			continue
		case "..":
			if len(out) > 0 {
				last := len(out) - 1
				if out[last] == "" && last == 0 {
					continue
				}
				out = out[:last]
			}
			continue
		default:
			out = append(out, segment)
		}
	}
	result := strings.Join(out, "/")
	if absolute && !strings.HasPrefix(result, "/") {
		result = "/" + result
	}
	if result == "" {
		result = "/"
	}
	if trailing && result != "/" && !strings.HasSuffix(result, "/") {
		result += "/"
	}
	return result
}

func normalizePercentEncoding(value string) string {
	if !strings.Contains(value, "%") {
		return value
	}
	var b strings.Builder
	b.Grow(len(value))
	for i := 0; i < len(value); i++ {
		if value[i] != '%' || i+2 >= len(value) {
			b.WriteByte(value[i])
			continue
		}
		hi, okHi := fromHex(value[i+1])
		lo, okLo := fromHex(value[i+2])
		if !okHi || !okLo {
			b.WriteByte(value[i])
			continue
		}
		decoded := hi<<4 | lo
		if isUnreserved(decoded) {
			b.WriteByte(decoded)
		} else {
			b.WriteByte('%')
			b.WriteByte(toUpperHex(decoded >> 4))
			b.WriteByte(toUpperHex(decoded & 0x0f))
		}
		i += 2
	}
	return b.String()
}

func fromHex(c byte) (byte, bool) {
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

func toUpperHex(v byte) byte {
	if v < 10 {
		return '0' + v
	}
	return 'A' + (v - 10)
}

func isUnreserved(b byte) bool {
	return (b >= 'a' && b <= 'z') ||
		(b >= 'A' && b <= 'Z') ||
		(b >= '0' && b <= '9') ||
		b == '-' || b == '.' || b == '_' || b == '~'
}
