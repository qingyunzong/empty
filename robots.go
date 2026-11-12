package dataeng

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ErrUndecidable 表示无法获取 robots 文本，本次访问判定不可知。
var ErrUndecidable = errors.New("dataeng: robots policy undecidable")

// FetchFunc 获取指定 robots.txt URL 的文本内容。
// 传入的 ctx 不绑定任何调用方等待者：等待者取消不会取消共享获取。
type FetchFunc func(ctx context.Context, robotsURL string) (string, error)

// Policy 是按来源（scheme、主机、端口）缓存 robots 访问策略的组件。
type Policy struct {
	product string
	ttl     time.Duration
	now     func() time.Time
	fetch   FetchFunc

	mu      sync.Mutex
	entries map[string]*entry
}

// NewPolicy 创建策略组件。product 为产品标识，ttl 为正缓存有效期，
// now 为注入时钟，fetch 用于获取 robots 文本。
func NewPolicy(product string, ttl time.Duration, now func() time.Time, fetch FetchFunc) *Policy {
	if now == nil {
		now = time.Now
	}
	return &Policy{
		product: product,
		ttl:     ttl,
		now:     now,
		fetch:   fetch,
		entries: make(map[string]*entry),
	}
}

// Allowed 判定是否允许抓取 rawURL。获取 robots 失败时返回 ErrUndecidable。
func (p *Policy) Allowed(ctx context.Context, rawURL string) (bool, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false, fmt.Errorf("dataeng: parse url: %w", err)
	}
	rules, err := p.rulesFor(ctx, u)
	if err != nil {
		return false, err
	}
	return rules.allowed(escapedPathQuery(u)), nil
}

type entry struct {
	rules     *ruleSet
	expiresAt time.Time
	inflight  *refreshCall
}

type refreshCall struct {
	done  chan struct{}
	rules *ruleSet
	err   error
}

func (p *Policy) rulesFor(ctx context.Context, u *url.URL) (*ruleSet, error) {
	key := originKey(u)
	p.mu.Lock()
	e := p.entries[key]
	if e == nil {
		e = &entry{}
		p.entries[key] = e
	}
	// 恰到期即视为过期，必须刷新。
	if e.rules != nil && p.now().Before(e.expiresAt) {
		rules := e.rules
		p.mu.Unlock()
		return rules, nil
	}
	if e.inflight != nil {
		call := e.inflight
		p.mu.Unlock()
		select {
		case <-call.done:
			return call.rules, call.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	call := &refreshCall{done: make(chan struct{})}
	e.inflight = call
	p.mu.Unlock()

	robotsURL := *u
	robotsURL.Path = "/robots.txt"
	robotsURL.RawPath = ""
	robotsURL.RawQuery = ""
	robotsURL.Fragment = ""
	go p.refresh(e, call, robotsURL.String())

	select {
	case <-call.done:
		return call.rules, call.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (p *Policy) refresh(e *entry, call *refreshCall, robotsURL string) {
	text, fetchErr := p.fetch(context.Background(), robotsURL)
	p.mu.Lock()
	if fetchErr == nil {
		call.rules = parseRobots(text, p.product)
		e.rules = call.rules
		e.expiresAt = p.now().Add(p.ttl)
	} else {
		call.err = ErrUndecidable
	}
	e.inflight = nil
	p.mu.Unlock()
	close(call.done)
}

func originKey(u *url.URL) string {
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if port == "" {
		switch scheme {
		case "http":
			port = "80"
		case "https":
			port = "443"
		}
	}
	return scheme + "://" + host + ":" + port
}

func escapedPathQuery(u *url.URL) string {
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	if u.ForceQuery || u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	return path
}

type rule struct {
	allow   bool
	pattern string
	weight  int
}

type ruleSet struct {
	rules []rule
}

// allowed 依据最长非星号字节数规则判定；平局 Allow 胜出；无匹配默认允许。
func (rs *ruleSet) allowed(path string) bool {
	best := -1
	allowed := true
	for _, r := range rs.rules {
		if !matchPattern(r.pattern, path) {
			continue
		}
		if r.weight > best {
			best = r.weight
			allowed = r.allow
		} else if r.weight == best && r.allow {
			allowed = true
		}
	}
	return allowed
}

// matchPattern 按原始字节匹配：星号匹配任意字节序列，
// 末尾美元符锚定末尾；不做百分号解码。
func matchPattern(pattern, path string) bool {
	anchor := strings.HasSuffix(pattern, "$")
	if anchor {
		pattern = pattern[:len(pattern)-1]
	}
	var match func(pi, si int) bool
	match = func(pi, si int) bool {
		for pi < len(pattern) {
			if pattern[pi] == '*' {
				for pi+1 < len(pattern) && pattern[pi+1] == '*' {
					pi++
				}
				if pi+1 == len(pattern) {
					return true
				}
				for k := si; k <= len(path); k++ {
					if match(pi+1, k) {
						return true
					}
				}
				return false
			}
			if si >= len(path) || pattern[pi] != path[si] {
				return false
			}
			pi++
			si++
		}
		return !anchor || si == len(path)
	}
	return match(0, 0)
}

func ruleWeight(pattern string) int {
	weight := 0
	for i := 0; i < len(pattern); i++ {
		if pattern[i] == '*' {
			continue
		}
		if pattern[i] == '$' && i == len(pattern)-1 {
			continue
		}
		weight++
	}
	return weight
}

type group struct {
	names []string
	rules []rule
}

// parseRobots 解析 robots 文本并为 product 选择规则组：
// 最长的不区分 ASCII 大小写匹配组名胜出，同长度组合并；无匹配用星号组。
func parseRobots(text, product string) *ruleSet {
	var groups []*group
	var current *group
	for _, line := range strings.Split(text, "\n") {
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		field := strings.ToLower(strings.TrimSpace(line[:colon]))
		value := strings.TrimSpace(line[colon+1:])
		switch field {
		case "user-agent":
			if current == nil || len(current.rules) > 0 {
				current = &group{}
				groups = append(groups, current)
			}
			current.names = append(current.names, value)
		case "allow", "disallow":
			if current == nil || value == "" {
				continue
			}
			current.rules = append(current.rules, rule{
				allow:   field == "allow",
				pattern: value,
				weight:  ruleWeight(value),
			})
		}
	}

	lowerProduct := strings.ToLower(product)
	bestLen := -1
	var selected []*group
	for _, g := range groups {
		groupBest := -1
		for _, name := range g.names {
			if name == "*" {
				continue
			}
			if strings.Contains(lowerProduct, strings.ToLower(name)) && len(name) > groupBest {
				groupBest = len(name)
			}
		}
		if groupBest < 0 {
			continue
		}
		if groupBest > bestLen {
			bestLen = groupBest
			selected = selected[:0]
		}
		if groupBest == bestLen {
			selected = append(selected, g)
		}
	}
	if bestLen < 0 {
		for _, g := range groups {
			for _, name := range g.names {
				if name == "*" {
					selected = append(selected, g)
					break
				}
			}
		}
	}

	rs := &ruleSet{}
	for _, g := range selected {
		rs.rules = append(rs.rules, g.rules...)
	}
	return rs
}
