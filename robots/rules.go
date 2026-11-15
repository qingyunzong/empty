package robots

import (
	"net/url"
	"strings"
	"time"
)

// Rule is one Allow or Disallow directive.
type Rule struct {
	Allow   bool
	Pattern string
}

// Group is a parsed set of user-agent directives. UserAgents are lower-case
// product tokens, including the "*" wildcard.
type Group struct {
	UserAgents []string
	Rules      []Rule
	CrawlDelay time.Duration
}

// Rules is an immutable parsed robots.txt document. Callers must not modify
// Groups, nested slices or Sitemaps after parsing. Use Clone for an
// independent copy.
type Rules struct {
	Groups   []Group
	Sitemaps []string
}

// AgentRules is the merged rule set selected for one user agent.
type AgentRules struct {
	UserAgent  string
	Rules      []Rule
	CrawlDelay time.Duration
	Matched    bool
}

// Decision is the result of evaluating a target path.
type Decision struct {
	Allowed    bool
	Matched    bool
	Rule       Rule
	UserAgent  string
	CrawlDelay time.Duration
}

// Clone returns a deep copy of r.
func (r *Rules) Clone() *Rules {
	if r == nil {
		return nil
	}
	out := &Rules{
		Groups:   make([]Group, len(r.Groups)),
		Sitemaps: append([]string(nil), r.Sitemaps...),
	}
	for i, group := range r.Groups {
		out.Groups[i] = Group{
			UserAgents: append([]string(nil), group.UserAgents...),
			Rules:      append([]Rule(nil), group.Rules...),
			CrawlDelay: group.CrawlDelay,
		}
	}
	return out
}

// AllowAllRules returns a policy that permits every target.
func AllowAllRules() *Rules {
	return &Rules{}
}

// DisallowAllRules returns a policy that denies every target.
func DisallowAllRules() *Rules {
	return &Rules{Groups: []Group{{
		UserAgents: []string{"*"},
		Rules:      []Rule{{Allow: false, Pattern: "*"}},
	}}}
}

// For selects and merges the most specific user-agent groups that match ua.
// When several groups have the same specificity, their directives are merged
// in file order and the strictest (largest) crawl delay is retained.
func (r *Rules) For(ua string) AgentRules {
	if r == nil || len(r.Groups) == 0 {
		return AgentRules{}
	}

	ua = strings.ToLower(ua)
	best := -1
	matchedToken := ""
	var selected []Group

	for _, group := range r.Groups {
		specificity := -1
		token := ""
		for _, candidate := range group.UserAgents {
			candidate = strings.ToLower(strings.TrimSpace(candidate))
			if candidate == "" {
				continue
			}
			if candidate == "*" {
				if specificity < 0 {
					specificity = 0
					token = "*"
				}
				continue
			}
			if strings.Contains(ua, candidate) && len(candidate) > specificity {
				specificity = len(candidate)
				token = candidate
			}
		}
		if specificity < 0 {
			continue
		}
		if specificity > best {
			best = specificity
			matchedToken = token
			selected = selected[:0]
		}
		if specificity == best {
			selected = append(selected, group)
		}
	}

	if len(selected) == 0 {
		return AgentRules{}
	}

	agent := AgentRules{UserAgent: matchedToken, Matched: true}
	for _, group := range selected {
		agent.Rules = append(agent.Rules, group.Rules...)
		if group.CrawlDelay > agent.CrawlDelay {
			agent.CrawlDelay = group.CrawlDelay
		}
	}
	return agent
}

// Evaluate returns the decision for target under ua. Target may be an
// absolute URL, an origin-form path, or a path with a query string. Matching
// is case-sensitive and uses the raw (still percent-encoded) path.
func (r *Rules) Evaluate(ua, target string) Decision {
	agent := r.For(ua)
	path := RequestPath(target)
	decision := Decision{
		Allowed:    true,
		UserAgent:  agent.UserAgent,
		CrawlDelay: agent.CrawlDelay,
	}

	best := -1
	for _, rule := range agent.Rules {
		if rule.Pattern == "" {
			continue
		}
		ok, _ := matchPattern(rule.Pattern, path)
		if !ok {
			continue
		}
		specificity := ruleSpecificity(rule.Pattern)
		if specificity > best || (specificity == best && rule.Allow) {
			best = specificity
			decision.Allowed = rule.Allow
			decision.Matched = true
			decision.Rule = rule
		}
	}
	return decision
}

// Allowed is a convenience wrapper around Evaluate.
func (r *Rules) Allowed(ua, target string) bool {
	return r.Evaluate(ua, target).Allowed
}

// CrawlDelayFor returns the configured delay for ua, or zero.
func (r *Rules) CrawlDelayFor(ua string) time.Duration {
	return r.For(ua).CrawlDelay
}

// RequestPath normalises a target into the raw path and query used for rule
// matching. Fragments are discarded.
func RequestPath(target string) string {
	if target == "" {
		return "/"
	}

	if strings.Contains(target, "://") {
		if u, err := url.Parse(target); err == nil && u.Host != "" {
			path := u.EscapedPath()
			if path == "" {
				path = "/"
			}
			if u.RawQuery != "" {
				path += "?" + u.RawQuery
			}
			return path
		}
	}

	if strings.HasPrefix(target, "#") {
		return "/"
	}
	if !strings.HasPrefix(target, "/") {
		target = "/" + target
	}
	if i := strings.IndexByte(target, '#'); i >= 0 {
		target = target[:i]
	}
	if target == "" {
		return "/"
	}
	return target
}

func ruleSpecificity(pattern string) int {
	pattern = strings.TrimSuffix(pattern, "$")
	return len(pattern)
}

// matchPattern implements the RFC 9309 prefix match with "*" wildcards and a
// terminal "$" anchor. It returns the number of target bytes consumed.
func matchPattern(pattern, target string) (bool, int) {
	anchored := strings.HasSuffix(pattern, "$")
	if anchored {
		pattern = pattern[:len(pattern)-1]
	}

	parts := strings.Split(pattern, "*")
	position := 0
	if parts[0] != "" {
		if !strings.HasPrefix(target, parts[0]) {
			return false, 0
		}
		position = len(parts[0])
	}

	for i := 1; i < len(parts); i++ {
		part := parts[i]
		if part == "" {
			continue
		}
		if i == len(parts)-1 && anchored {
			if !strings.HasSuffix(target, part) {
				return false, 0
			}
			start := len(target) - len(part)
			if start < position {
				return false, 0
			}
			position = len(target)
			continue
		}
		index := strings.Index(target[position:], part)
		if index < 0 {
			return false, 0
		}
		position += index + len(part)
	}

	if anchored && len(parts) == 1 && position != len(target) {
		return false, 0
	}
	return true, position
}
