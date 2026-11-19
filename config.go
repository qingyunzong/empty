package formal

import (
	"sort"
	"strings"
	"time"
)

// DefaultAttemptTimeout is used when Config.Timeout is zero.
const DefaultAttemptTimeout = 5 * time.Second

// Forwarder identifies one upstream resolver. Timeout overrides Config.Timeout
// for this forwarder when it is greater than zero.
type Forwarder struct {
	Address string
	Timeout time.Duration
}

// Config describes resolver routing policy.
//
// StubDomains maps a DNS suffix to an ordered list of forwarders. The most
// specific matching suffix wins. SearchDomains are appended in order while
// trying a relative name. Ndots controls whether the absolute name or the
// search-suffixed names are tried first.
type Config struct {
	StubDomains       map[string][]Forwarder
	DefaultForwarders []Forwarder
	SearchDomains     []string
	Ndots             int
	Timeout           time.Duration
}

type stubRule struct {
	domain     string
	forwarders []Forwarder
}

type compiledConfig struct {
	stubs         []stubRule
	defaults      []Forwarder
	searchDomains []string
	ndots         int
	timeout       time.Duration
}

// Validate checks the configuration and reports the first invalid field. A
// successful validation guarantees that Resolve can route any valid name.
func (c Config) Validate() error {
	_, err := compileConfig(c)
	return err
}

func compileConfig(c Config) (*compiledConfig, error) {
	if c.Ndots < 0 {
		return nil, configError("ndots", c.Ndots, "must be >= 0")
	}

	timeout := c.Timeout
	if timeout == 0 {
		timeout = DefaultAttemptTimeout
	}
	if timeout < 0 {
		return nil, configError("timeout", c.Timeout, "must be >= 0 (zero uses the default)")
	}

	defaults, err := validateForwarders("default_forwarders", c.DefaultForwarders)
	if err != nil {
		return nil, err
	}
	if len(defaults) == 0 {
		return nil, configError("default_forwarders", nil, "at least one forwarder is required")
	}

	searches := make([]string, 0, len(c.SearchDomains))
	seenSearch := make(map[string]string, len(c.SearchDomains))
	for i, raw := range c.SearchDomains {
		domain, err := canonicalDomain(raw)
		if err != nil {
			return nil, configError("search_domains", raw, "index %d: %v", i, err)
		}
		if prev, exists := seenSearch[domain]; exists {
			return nil, configError("search_domains", raw, "duplicate of %q after canonicalization", prev)
		}
		seenSearch[domain] = raw
		searches = append(searches, domain)
	}

	stubs := make([]stubRule, 0, len(c.StubDomains))
	seenStub := make(map[string]string, len(c.StubDomains))
	keys := make([]string, 0, len(c.StubDomains))
	for raw := range c.StubDomains {
		keys = append(keys, raw)
	}
	sort.Strings(keys)
	for _, raw := range keys {
		domain, err := canonicalDomain(raw)
		if err != nil {
			return nil, configError("stub_domains", raw, "%v", err)
		}
		if prev, exists := seenStub[domain]; exists {
			return nil, configError("stub_domains", raw, "duplicate of %q after canonicalization", prev)
		}
		seenStub[domain] = raw

		forwarders, err := validateForwarders("stub_domains["+raw+"]", c.StubDomains[raw])
		if err != nil {
			return nil, err
		}
		if len(forwarders) == 0 {
			return nil, configError("stub_domains["+raw+"]", raw, "at least one forwarder is required")
		}
		stubs = append(stubs, stubRule{domain: domain, forwarders: forwarders})
	}

	// Longest suffix first. The lexicographic tie-break makes iteration
	// deterministic even for programmatically constructed (invalid) configs.
	sort.Slice(stubs, func(i, j int) bool {
		if len(stubs[i].domain) != len(stubs[j].domain) {
			return len(stubs[i].domain) > len(stubs[j].domain)
		}
		return stubs[i].domain < stubs[j].domain
	})

	return &compiledConfig{
		stubs:         stubs,
		defaults:      defaults,
		searchDomains: searches,
		ndots:         c.Ndots,
		timeout:       timeout,
	}, nil
}

func validateForwarders(field string, in []Forwarder) ([]Forwarder, error) {
	out := make([]Forwarder, len(in))
	seen := make(map[string]struct{}, len(in))
	for i, f := range in {
		address := f.Address
		if strings.TrimSpace(address) == "" {
			return nil, configError(field, address, "index %d: address must not be empty", i)
		}
		if strings.TrimSpace(address) != address {
			return nil, configError(field, address, "index %d: address has surrounding whitespace", i)
		}
		if f.Timeout < 0 {
			return nil, configError(field, f.Timeout, "index %d: timeout must be >= 0", i)
		}
		if _, exists := seen[address]; exists {
			return nil, configError(field, address, "duplicate forwarder address")
		}
		seen[address] = struct{}{}
		out[i] = f
	}
	return out, nil
}

func (c *compiledConfig) route(name string) (forwarders []Forwarder, stubDomain string) {
	name = strings.ToLower(strings.TrimSuffix(name, "."))
	for _, rule := range c.stubs {
		if name == rule.domain || strings.HasSuffix(name, "."+rule.domain) {
			return rule.forwarders, rule.domain
		}
	}
	return c.defaults, ""
}

func (c *compiledConfig) forwarderTimeout(f Forwarder) time.Duration {
	if f.Timeout > 0 {
		return f.Timeout
	}
	return c.timeout
}
