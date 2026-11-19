// Package oracle is an independently written reference implementation of the
// resolver policy. Tests use it to compute expected observations without
// calling any routing or name-handling code from the package under test.
package oracle

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"example.org/dlks/formal/q10059"
)

// Observation is the comparable, policy-level trace produced by the oracle.
type Observation struct {
	Name         string
	Queries      []QueryStep
	Attempts     []Attempt
	Source       Source
	Elapsed      time.Duration
	CachedValues []string
}

type QueryStep struct {
	Name     string
	CacheHit bool
}

type Attempt struct {
	Name       string
	Forwarder  string
	StubDomain string
	Outcome    string
	Rcode      formal.Rcode
	Latency    time.Duration
	Waited     time.Duration
	Err        string
}

type Source struct {
	Kind       string
	Name       string
	Forwarder  string
	StubDomain string
	Rcode      formal.Rcode
	Reason     string
}

// Input is all data needed to compute one expected resolution.
type Input struct {
	Name      string
	Config    formal.Config
	Cache     map[string]formal.CacheEntry
	Transport formal.Transport
}

type rule struct {
	domain     string
	forwarders []formal.Forwarder
}

type policy struct {
	rules    []rule
	defaults []formal.Forwarder
	search   []string
	ndots    int
	timeout  time.Duration
}

// Run computes the expected observation using only the oracle's own policy
// implementation.
func Run(in Input) (Observation, error) {
	pol, err := compile(in.Config)
	if err != nil {
		return Observation{}, err
	}
	name, err := parseName(in.Name)
	if err != nil {
		return Observation{}, err
	}

	obs := Observation{Name: display(name.body)}
	var elapsed time.Duration
	var lastName string
	var lastCode formal.Rcode
	var lastWhy string

candidateLoop:
	for _, candidate := range candidates(name, pol) {
		lastName = candidate

		if entry, hit := lookup(in.Cache, candidate); hit {
			obs.Queries = append(obs.Queries, QueryStep{Name: candidate, CacheHit: true})
			if entry.Rcode == formal.RcodeSuccess {
				obs.CachedValues = append([]string(nil), entry.Values...)
				obs.Source = Source{
					Kind:  "cache",
					Name:  candidate,
					Rcode: formal.RcodeSuccess,
				}
				obs.Elapsed = elapsed
				return obs, nil
			}
			lastCode = entry.Rcode
			lastWhy = reason(entry.Rcode)
			continue
		}

		obs.Queries = append(obs.Queries, QueryStep{Name: candidate, CacheHit: false})
		forwarders, stub := pol.pick(candidate)
		if len(forwarders) == 0 {
			lastCode = formal.RcodeRefused
			lastWhy = "no-route"
			continue
		}
		if in.Transport == nil {
			return Observation{}, fmt.Errorf("%w: cannot resolve %s", formal.ErrNoTransport, candidate)
		}

		candidateWhy := ""
		for _, f := range forwarders {
			limit := pol.timeout
			if f.Timeout > 0 {
				limit = f.Timeout
			}
			reply := in.Transport.Exchange(candidate, f.Address)

			latency := reply.Latency
			if latency < 0 {
				latency = 0
			}
			waited := latency
			if waited > limit {
				waited = limit
			}
			elapsed += waited

			attempt := Attempt{
				Name:       candidate,
				Forwarder:  f.Address,
				StubDomain: stub,
				Latency:    latency,
				Waited:     waited,
				Rcode:      reply.Rcode,
			}

			if reply.Latency > limit {
				attempt.Outcome = "timeout"
				if reply.Err != nil {
					attempt.Err = reply.Err.Error()
				}
				obs.Attempts = append(obs.Attempts, attempt)
				candidateWhy = "timeout"
				lastCode = reply.Rcode
				continue
			}
			if reply.Err != nil {
				attempt.Outcome = "failure"
				attempt.Err = reply.Err.Error()
				obs.Attempts = append(obs.Attempts, attempt)
				candidateWhy = "failure"
				lastCode = reply.Rcode
				continue
			}

			switch reply.Rcode {
			case formal.RcodeSuccess:
				attempt.Outcome = "success"
				obs.Attempts = append(obs.Attempts, attempt)
				kind := "default"
				if stub != "" {
					kind = "stub"
				}
				obs.Source = Source{
					Kind:       kind,
					Name:       candidate,
					Forwarder:  f.Address,
					StubDomain: stub,
					Rcode:      formal.RcodeSuccess,
				}
				obs.Elapsed = elapsed
				return obs, nil
			case formal.RcodeNameError:
				attempt.Outcome = "nxdomain"
				obs.Attempts = append(obs.Attempts, attempt)
				lastCode = formal.RcodeNameError
				lastWhy = "nxdomain"
				continue candidateLoop
			default:
				attempt.Outcome = "failure"
				obs.Attempts = append(obs.Attempts, attempt)
				candidateWhy = "failure"
				lastCode = reply.Rcode
			}
		}

		if candidateWhy == "" {
			candidateWhy = "failure"
		}
		lastWhy = candidateWhy
	}

	obs.Elapsed = elapsed
	obs.Source = Source{
		Kind:   "none",
		Name:   lastName,
		Rcode:  lastCode,
		Reason: lastWhy,
	}
	return obs, nil
}

func compile(c formal.Config) (policy, error) {
	if c.Ndots < 0 {
		return policy{}, fmt.Errorf("%w: ndots must be >= 0", formal.ErrInvalidConfig)
	}
	timeout := c.Timeout
	if timeout == 0 {
		timeout = formal.DefaultAttemptTimeout
	}
	if timeout < 0 {
		return policy{}, fmt.Errorf("%w: timeout must be > 0", formal.ErrInvalidConfig)
	}

	defaults, err := checkForwarders(c.DefaultForwarders)
	if err != nil {
		return policy{}, err
	}
	if len(defaults) == 0 {
		return policy{}, fmt.Errorf("%w: default forwarders are empty", formal.ErrInvalidConfig)
	}

	seenSearch := map[string]bool{}
	search := make([]string, 0, len(c.SearchDomains))
	for _, raw := range c.SearchDomains {
		domain, err := canonDomain(raw)
		if err != nil {
			return policy{}, fmt.Errorf("%w: search domain %q: %v", formal.ErrInvalidConfig, raw, err)
		}
		if seenSearch[domain] {
			return policy{}, fmt.Errorf("%w: duplicate search domain %q", formal.ErrInvalidConfig, domain)
		}
		seenSearch[domain] = true
		search = append(search, domain)
	}

	seenStub := map[string]bool{}
	keys := make([]string, 0, len(c.StubDomains))
	for raw := range c.StubDomains {
		keys = append(keys, raw)
	}
	sort.Strings(keys)
	rules := make([]rule, 0, len(keys))
	for _, raw := range keys {
		domain, err := canonDomain(raw)
		if err != nil {
			return policy{}, fmt.Errorf("%w: stub domain %q: %v", formal.ErrInvalidConfig, raw, err)
		}
		if seenStub[domain] {
			return policy{}, fmt.Errorf("%w: duplicate stub domain %q", formal.ErrInvalidConfig, domain)
		}
		seenStub[domain] = true
		forwarders, err := checkForwarders(c.StubDomains[raw])
		if err != nil {
			return policy{}, err
		}
		if len(forwarders) == 0 {
			return policy{}, fmt.Errorf("%w: stub domain %q has no forwarders", formal.ErrInvalidConfig, raw)
		}
		rules = append(rules, rule{domain: domain, forwarders: forwarders})
	}
	sort.Slice(rules, func(i, j int) bool {
		if len(rules[i].domain) != len(rules[j].domain) {
			return len(rules[i].domain) > len(rules[j].domain)
		}
		return rules[i].domain < rules[j].domain
	})

	return policy{rules: rules, defaults: defaults, search: search, ndots: c.Ndots, timeout: timeout}, nil
}

func checkForwarders(in []formal.Forwarder) ([]formal.Forwarder, error) {
	out := make([]formal.Forwarder, len(in))
	seen := map[string]bool{}
	for i, f := range in {
		if strings.TrimSpace(f.Address) == "" {
			return nil, fmt.Errorf("%w: forwarder %d has empty address", formal.ErrInvalidConfig, i)
		}
		if strings.TrimSpace(f.Address) != f.Address {
			return nil, fmt.Errorf("%w: forwarder %q has surrounding whitespace", formal.ErrInvalidConfig, f.Address)
		}
		if f.Timeout < 0 {
			return nil, fmt.Errorf("%w: forwarder %q has negative timeout", formal.ErrInvalidConfig, f.Address)
		}
		if seen[f.Address] {
			return nil, fmt.Errorf("%w: duplicate forwarder %q", formal.ErrInvalidConfig, f.Address)
		}
		seen[f.Address] = true
		out[i] = f
	}
	return out, nil
}

type parsed struct {
	body     string
	absolute bool
	dots     int
}

func parseName(raw string) (parsed, error) {
	if raw == "" {
		return parsed{}, fmt.Errorf("%w: empty name", formal.ErrInvalidName)
	}
	if strings.TrimSpace(raw) != raw {
		return parsed{}, fmt.Errorf("%w: surrounding whitespace", formal.ErrInvalidName)
	}
	if raw == "." {
		return parsed{absolute: true}, nil
	}
	absolute := strings.HasSuffix(raw, ".")
	body := strings.TrimSuffix(raw, ".")
	canon, err := canonDomain(body)
	if err != nil {
		return parsed{}, fmt.Errorf("%w: %v", formal.ErrInvalidName, err)
	}
	return parsed{body: canon, absolute: absolute, dots: strings.Count(canon, ".")}, nil
}

func canonDomain(raw string) (string, error) {
	if raw == "" {
		return "", fmt.Errorf("empty domain")
	}
	if strings.TrimSpace(raw) != raw {
		return "", fmt.Errorf("surrounding whitespace")
	}
	if raw == "." {
		return "", fmt.Errorf("root domain not allowed")
	}
	body := strings.TrimSuffix(raw, ".")
	if body == "" {
		return "", fmt.Errorf("empty domain")
	}
	if len(body) > 253 {
		return "", fmt.Errorf("domain too long")
	}
	body = strings.ToLower(body)
	for i, label := range strings.Split(body, ".") {
		if label == "" {
			return "", fmt.Errorf("empty label %d", i+1)
		}
		if len(label) > 63 {
			return "", fmt.Errorf("label too long")
		}
		for _, r := range label {
			ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_'
			if !ok {
				return "", fmt.Errorf("invalid character %q", r)
			}
		}
	}
	return body, nil
}

func display(body string) string {
	if body == "" {
		return "."
	}
	return body + "."
}

func candidates(name parsed, pol policy) []string {
	abs := display(name.body)
	if name.absolute {
		return []string{abs}
	}
	var suffixed []string
	for _, domain := range pol.search {
		suffixed = append(suffixed, display(name.body+"."+domain))
	}
	if name.dots >= pol.ndots {
		return append([]string{abs}, suffixed...)
	}
	return append(suffixed, abs)
}

func (p policy) pick(name string) ([]formal.Forwarder, string) {
	name = strings.ToLower(strings.TrimSuffix(name, "."))
	for _, r := range p.rules {
		if name == r.domain || strings.HasSuffix(name, "."+r.domain) {
			return r.forwarders, r.domain
		}
	}
	return p.defaults, ""
}

func lookup(cache map[string]formal.CacheEntry, name string) (formal.CacheEntry, bool) {
	if entry, ok := cache[name]; ok {
		return entry, true
	}
	target := strings.ToLower(strings.TrimSuffix(name, "."))
	keys := make([]string, 0, len(cache))
	for key := range cache {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if strings.ToLower(strings.TrimSuffix(key, ".")) == target {
			return cache[key], true
		}
	}
	return formal.CacheEntry{}, false
}

func reason(rcode formal.Rcode) string {
	if rcode == formal.RcodeNameError {
		return "nxdomain"
	}
	return "cache-entry"
}
