package robots

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"unicode"
)

// ErrInvalidOrigin is returned when a value cannot represent an HTTP origin.
var ErrInvalidOrigin = errors.New("robots: invalid origin")

// Origin identifies a policy scope by scheme, host and port. Host is stored
// without brackets or a trailing dot and in lower case. Port is always
// explicit, using the scheme's default when the input omits it.
type Origin struct {
	Scheme string
	Host   string
	Port   string
}

// NewOrigin canonicalises and validates an origin.
func NewOrigin(scheme, host, port string) (Origin, error) {
	scheme = strings.ToLower(strings.TrimSpace(scheme))
	host = strings.TrimSpace(host)
	host = strings.TrimPrefix(host, "[")
	host = strings.TrimSuffix(host, "]")
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	port = strings.TrimSpace(port)

	if scheme == "" {
		return Origin{}, fmt.Errorf("%w: missing scheme", ErrInvalidOrigin)
	}
	if !validScheme(scheme) {
		return Origin{}, fmt.Errorf("%w: invalid scheme %q", ErrInvalidOrigin, scheme)
	}
	if host == "" {
		return Origin{}, fmt.Errorf("%w: missing host", ErrInvalidOrigin)
	}
	if strings.ContainsAny(host, "/\\?#@[]") || strings.IndexFunc(host, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	}) >= 0 {
		return Origin{}, fmt.Errorf("%w: invalid host %q", ErrInvalidOrigin, host)
	}
	if port == "" {
		switch scheme {
		case "http":
			port = "80"
		case "https":
			port = "443"
		default:
			return Origin{}, fmt.Errorf("%w: missing port for scheme %q", ErrInvalidOrigin, scheme)
		}
	}

	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return Origin{}, fmt.Errorf("%w: invalid port %q", ErrInvalidOrigin, port)
	}

	return Origin{Scheme: scheme, Host: host, Port: strconv.Itoa(number)}, nil
}

func validScheme(scheme string) bool {
	for index, r := range scheme {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
			if index == 0 {
				return false
			}
		case r == '+' || r == '-' || r == '.':
			if index == 0 {
				return false
			}
		default:
			return false
		}
	}
	return scheme != ""
}

// ParseOrigin parses a URL or authority-like value. Paths, queries and
// fragments are ignored because a robots policy is scoped to the origin.
func ParseOrigin(raw string) (Origin, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Origin{}, fmt.Errorf("%w: empty value", ErrInvalidOrigin)
	}

	u, err := url.Parse(raw)
	if err != nil {
		return Origin{}, fmt.Errorf("%w: %v", ErrInvalidOrigin, err)
	}
	if u.Scheme == "" {
		return Origin{}, fmt.Errorf("%w: missing scheme", ErrInvalidOrigin)
	}

	return NewOrigin(u.Scheme, u.Hostname(), u.Port())
}

// OriginFromURL derives a canonical origin from a parsed URL.
func OriginFromURL(u *url.URL) (Origin, error) {
	if u == nil {
		return Origin{}, fmt.Errorf("%w: nil URL", ErrInvalidOrigin)
	}
	return NewOrigin(u.Scheme, u.Hostname(), u.Port())
}

// Validate reports whether o is a usable origin.
func (o Origin) Validate() error {
	_, err := o.Canonical()
	return err
}

// Canonical returns the normalised form of o.
func (o Origin) Canonical() (Origin, error) {
	return NewOrigin(o.Scheme, o.Host, o.Port)
}

// IsZero reports whether o is the zero value.
func (o Origin) IsZero() bool {
	return o.Scheme == "" && o.Host == "" && o.Port == ""
}

// String returns the canonical origin, including an explicit port.
func (o Origin) String() string {
	return o.Scheme + "://" + o.HostPort()
}

// HostPort returns the canonical host and port. IPv6 literals are bracketed.
func (o Origin) HostPort() string {
	if strings.Contains(o.Host, ":") {
		return "[" + o.Host + "]:" + o.Port
	}
	return o.Host + ":" + o.Port
}

// Key returns the exact cache key representation for the origin.
func (o Origin) Key() string {
	return o.String()
}

// RobotsURL returns the canonical robots.txt URL for the origin.
func (o Origin) RobotsURL() string {
	return o.String() + "/robots.txt"
}
