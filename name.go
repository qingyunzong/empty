package formal

import (
	"fmt"
	"strings"
)

// parsedName is a query name split into its absolute/relative form. canonical
// never has a trailing dot, except that the DNS root is represented by "".
type parsedName struct {
	original  string
	canonical string
	absolute  bool
	dots      int
}

func parseQueryName(raw string) (parsedName, error) {
	if raw == "" {
		return parsedName{}, fmt.Errorf("%w: name is empty", ErrInvalidName)
	}
	if strings.TrimSpace(raw) != raw {
		return parsedName{}, fmt.Errorf("%w: name %q has surrounding whitespace", ErrInvalidName, raw)
	}
	if raw == "." {
		return parsedName{original: raw, canonical: "", absolute: true}, nil
	}

	absolute := false
	body := raw
	if strings.HasSuffix(body, ".") {
		absolute = true
		body = body[:len(body)-1]
	}

	canonical, err := canonicalDomain(body)
	if err != nil {
		return parsedName{}, fmt.Errorf("%w: %q: %v", ErrInvalidName, raw, err)
	}

	return parsedName{
		original:  raw,
		canonical: canonical,
		absolute:  absolute,
		dots:      strings.Count(canonical, "."),
	}, nil
}

// canonicalDomain lowercases a domain and validates its labels. The result
// never has a trailing dot. The root domain is not accepted by this helper.
func canonicalDomain(raw string) (string, error) {
	if raw == "" {
		return "", fmt.Errorf("domain is empty")
	}
	if strings.TrimSpace(raw) != raw {
		return "", fmt.Errorf("domain has surrounding whitespace")
	}
	if raw == "." {
		return "", fmt.Errorf("root domain is not valid here")
	}

	body := strings.TrimSuffix(raw, ".")
	if body == "" {
		return "", fmt.Errorf("domain is empty")
	}
	if len(body) > 253 {
		return "", fmt.Errorf("domain is longer than 253 bytes")
	}

	body = strings.ToLower(body)
	for i, label := range strings.Split(body, ".") {
		if label == "" {
			return "", fmt.Errorf("label %d is empty", i+1)
		}
		if len(label) > 63 {
			return "", fmt.Errorf("label %q is longer than 63 bytes", label)
		}
		for _, r := range label {
			switch {
			case r >= 'a' && r <= 'z':
			case r >= '0' && r <= '9':
			case r == '-' || r == '_':
			default:
				return "", fmt.Errorf("label %q contains invalid character %q", label, r)
			}
		}
	}
	return body, nil
}

// fqdn converts a canonical name without a trailing dot into wire-display
// form. The root name is the single character ".".
func fqdn(canonical string) string {
	if canonical == "" {
		return "."
	}
	return canonical + "."
}

// candidateNames returns the complete ordered query sequence for a name.
func candidateNames(name parsedName, cfg *compiledConfig) []string {
	absolute := fqdn(name.canonical)
	if name.absolute {
		return []string{absolute}
	}

	suffixed := make([]string, 0, len(cfg.searchDomains))
	for _, domain := range cfg.searchDomains {
		suffixed = append(suffixed, fqdn(name.canonical+"."+domain))
	}

	if name.dots >= cfg.ndots {
		return append([]string{absolute}, suffixed...)
	}
	return append(suffixed, absolute)
}
