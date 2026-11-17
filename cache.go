package formal

import (
	"sync"
	"time"
)

// maxCNAMEHops 限制单次查询跟随的 CNAME 跳数，防止环导致死循环。
const maxCNAMEHops = 64

type cacheKey struct {
	name  string // 经 NormalizeName 归一化的名称，大小写形式共享该键
	qtype RType
}

// entry 是一个缓存条目：要么持有一个正向 RRSet，要么持有一条否定结果。
// 每个条目独立到期，因此 CNAME 链中任一环节 TTL 到期只会移除该环节。
type entry struct {
	key         cacheKey
	displayName string // 首次写入时权威给出的原始大小写名称
	negative    bool
	rcode       RCode
	rrs         []RR // 正向 RRSet
	soa         RR   // 否定结果权威区中的 SOA 副本
	expire      time.Time
}

// Cache 是供递归查询路径调用的消息缓存。它对调用方并发安全。
type Cache struct {
	mu        sync.Mutex
	entries   map[cacheKey]*entry
	clock     Clock
	maxNegTTL time.Duration // 零值表示不对否定 TTL 设上限
}

// Option 配置 NewCache。
type Option func(*Cache)

// WithClock 注入时间来源；默认使用 SystemClock，测试可注入 VirtualClock。
func WithClock(clock Clock) Option {
	return func(c *Cache) { c.clock = clock }
}

// WithMaxNegativeTTL 为 NXDOMAIN/NODATA 的否定 TTL 设置上限（RFC 2308 允许实现封顶）。
func WithMaxNegativeTTL(d time.Duration) Option {
	return func(c *Cache) { c.maxNegTTL = d }
}

// NewCache 创建空缓存。
func NewCache(opts ...Option) *Cache {
	c := &Cache{
		entries: make(map[cacheKey]*entry),
		clock:   SystemClock{},
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// Len 返回当前持有的条目数（含未惰性清理的过期条目会在下次访问时删除）。
func (c *Cache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// Lookup 查询缓存。命中时返回重建的 Message（TTL 已折算为剩余秒数），
// 未命中返回 nil，调用方应向权威重新发起查询。
func (c *Cache) Lookup(name string, qtype RType) *Message {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.clock.Now()

	// 1. 名称级 NXDOMAIN（对该名称的任何 QTYPE 都成立）。
	if e := c.get(cacheKey{NormalizeName(name), TypeNXDOMAIN}, now); e != nil {
		return c.negativeMessage(name, qtype, e, now)
	}

	// 2. 名称与查询类型直接匹配的正向 RRSet。
	if e := c.get(cacheKey{NormalizeName(name), qtype}, now); e != nil && !e.negative {
		return c.positiveMessage(name, qtype, e, now)
	}

	// 3. 跟随 CNAME 链。链上每个 RRSet 独立到期：
	//    某一跳缺失即整体未命中，但其余跳的条目仍保留在缓存中。
	current := name
	var answer []RR
	for hops := 0; hops < maxCNAMEHops; hops++ {
		cname := c.get(cacheKey{NormalizeName(current), TypeCNAME}, now)
		if cname == nil || cname.negative || len(cname.rrs) == 0 {
			break
		}
		cnameRR := cname.rrs[0]
		cnameRR.TTL = remainingTTL(cname.expire, now)
		answer = append(answer, cnameRR)
		target := cnameRR.RData.(CNAMERData).Target

		if e := c.get(cacheKey{NormalizeName(target), TypeNXDOMAIN}, now); e != nil {
			return c.negativeMessage(name, qtype, e, now)
		}
		if e := c.get(cacheKey{NormalizeName(target), qtype}, now); e != nil {
			if !e.negative {
				answer = append(answer, c.adjustedRRs(e, now)...)
				return &Message{Name: name, QType: qtype, RCode: RCodeOK, Answer: answer}
			}
			return c.negativeMessage(name, qtype, e, now)
		}
		// 末端数据尚未命中时继续跟随下一跳 CNAME，而不是停在第一跳。
		current = target
	}

	// 4. 原始 (名称, 类型) 的 NODATA 否定结果。
	if e := c.get(cacheKey{NormalizeName(name), qtype}, now); e != nil && e.negative {
		return c.negativeMessage(name, qtype, e, now)
	}
	return nil
}

// Store 缓存一条权威应答。
//   - NXDOMAIN：依据权威区 SOA 计算否定 TTL 并按名称缓存，应答中的 CNAME 链同时缓存；
//   - 无回答的 NoError：作为 NODATA 按 (名称, QTYPE) 缓存；
//   - 有回答的 NoError：按 (名称, 类型) 分组为独立 RRSet 条目分别到期；
//   - SERVFAIL 等其他响应码不缓存。
func (c *Cache) Store(msg *Message) {
	if msg == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.clock.Now()

	switch msg.RCode {
	case RCodeNXDomain:
		c.storeNegative(msg, now)
		c.storeAnswerRRs(msg, now)
	case RCodeOK:
		if len(msg.Answer) > 0 {
			c.storeAnswerRRs(msg, now)
		} else {
			c.storeNegative(msg, now)
		}
	}
}

// get 返回未过期条目；过期条目在此惰性删除，只影响该键对应的结果。
func (c *Cache) get(key cacheKey, now time.Time) *entry {
	e, ok := c.entries[key]
	if !ok {
		return nil
	}
	if !e.expire.After(now) {
		delete(c.entries, key)
		return nil
	}
	return e
}

func (c *Cache) storeAnswerRRs(msg *Message, now time.Time) {
	type groupKey struct {
		name string
		typ  RType
	}
	groups := make(map[groupKey][]RR)
	minTTL := make(map[groupKey]uint32)
	var order []groupKey

	for _, rr := range msg.Answer {
		if rr.TTL == 0 {
			continue // TTL 为 0 的记录不得缓存
		}
		key := groupKey{NormalizeName(rr.Name), rr.Type}
		if _, ok := groups[key]; !ok {
			order = append(order, key)
			minTTL[key] = rr.TTL
		}
		groups[key] = append(groups[key], rr)
		if rr.TTL < minTTL[key] {
			minTTL[key] = rr.TTL
		}
	}

	for _, key := range order {
		rrs := groups[key]
		ttl := time.Duration(minTTL[key]) * time.Second
		c.entries[cacheKey{key.name, key.typ}] = &entry{
			key:         cacheKey{key.name, key.typ},
			displayName: rrs[0].Name,
			rrs:         append([]RR(nil), rrs...),
			expire:      now.Add(ttl),
		}
	}
}

// storeNegative 实现 RFC 2308：否定 TTL 取 SOA RR TTL 与 SOA MINIMUM 的较小值；
// 权威区未携带 SOA 时不缓存否定结果。
func (c *Cache) storeNegative(msg *Message, now time.Time) {
	soa := findSOA(msg.Authority)
	if soa == nil {
		return
	}
	ttl := negativeTTL(soa)
	if c.maxNegTTL > 0 && ttl > c.maxNegTTL {
		ttl = c.maxNegTTL
	}
	if ttl <= 0 {
		return
	}

	qtype := msg.QType
	if msg.RCode == RCodeNXDomain {
		qtype = TypeNXDOMAIN
	}
	soaCopy := *soa
	c.entries[cacheKey{NormalizeName(msg.Name), qtype}] = &entry{
		key:         cacheKey{NormalizeName(msg.Name), qtype},
		displayName: msg.Name,
		negative:    true,
		rcode:       msg.RCode,
		soa:         soaCopy,
		expire:      now.Add(ttl),
	}
}

func (c *Cache) positiveMessage(name string, qtype RType, e *entry, now time.Time) *Message {
	return &Message{
		Name:   name,
		QType:  qtype,
		RCode:  RCodeOK,
		Answer: c.adjustedRRs(e, now),
	}
}

func (c *Cache) negativeMessage(name string, qtype RType, e *entry, now time.Time) *Message {
	soa := e.soa
	soa.Name = e.displayName
	soa.TTL = remainingTTL(e.expire, now)
	return &Message{
		Name:      name,
		QType:     qtype,
		RCode:     e.rcode,
		Authority: []RR{soa},
	}
}

func (c *Cache) adjustedRRs(e *entry, now time.Time) []RR {
	rrs := make([]RR, len(e.rrs))
	for i, rr := range e.rrs {
		rr.TTL = remainingTTL(e.expire, now)
		rrs[i] = rr
	}
	return rrs
}

func findSOA(authority []RR) *RR {
	for i := range authority {
		if authority[i].Type == TypeSOA {
			if _, ok := authority[i].RData.(SOARData); ok {
				return &authority[i]
			}
		}
	}
	return nil
}

// negativeTTL 按 RFC 2308 第 5 节计算否定缓存 TTL。
func negativeTTL(soa *RR) time.Duration {
	minimum := soa.RData.(SOARData).Minimum
	ttl := soa.TTL
	if minimum < ttl {
		ttl = minimum
	}
	return time.Duration(ttl) * time.Second
}

// remainingTTL 返回距离到期的剩余整秒数；不足一秒按一秒计，避免提前到期。
func remainingTTL(expire, now time.Time) uint32 {
	d := expire.Sub(now)
	if d <= 0 {
		return 0
	}
	secs := d / time.Second
	if d%time.Second != 0 {
		secs++
	}
	return uint32(secs)
}
