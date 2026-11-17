package formal

// Authority 模拟递归解析器向上游权威发起的查询。
// 实现方在测试中可替换其区数据，以模拟权威区变更。
type Authority interface {
	Query(name string, qtype RType) *Message
}

// Resolver 是查询路径入口：先查缓存，未命中才向权威重新查询并回填缓存。
type Resolver struct {
	cache *Cache
	auth  Authority
}

// NewResolver 组装缓存与权威源。
func NewResolver(cache *Cache, auth Authority) *Resolver {
	return &Resolver{cache: cache, auth: auth}
}

// Lookup 返回 (名称, 类型) 的应答。
// 缓存命中（含完整 CNAME 链或否定结果）时不产生权威查询；
// 链中任一环节到期则从最早缺失的环节重新查询，缓存中仍有效的环节继续生效。
// 首次权威回填后同样从缓存重放应答，保证 TTL 被统一折算为剩余秒数。
func (r *Resolver) Lookup(name string, qtype RType) *Message {
	if msg := r.cache.Lookup(name, qtype); msg != nil {
		return msg
	}
	msg := r.auth.Query(name, qtype)
	if msg != nil {
		r.cache.Store(msg)
		if cached := r.cache.Lookup(name, qtype); cached != nil {
			return cached
		}
	}
	return msg
}

// MockAuthority 是按 (规范名称, 类型) 索引应答的内存权威，
// 可在测试中通过 ReplaceZone 模拟区变更，并统计查询次数以验证命中/重查边界。
type MockAuthority struct {
	queries int
	zone    map[cacheKey]*Message
}

// NewMockAuthority 创建空的内存权威。
func NewMockAuthority() *MockAuthority {
	return &MockAuthority{zone: make(map[cacheKey]*Message)}
}

// Add 向区中写入一条应答（按查询键索引）。
func (m *MockAuthority) Add(msg *Message) {
	m.zone[cacheKey{NormalizeName(msg.Name), msg.QType}] = msg
}

// Remove 从区中删除一条应答，用于模拟记录被删除。
func (m *MockAuthority) Remove(name string, qtype RType) {
	delete(m.zone, cacheKey{NormalizeName(name), qtype})
}

// ReplaceZone 整体替换区数据，用于模拟权威区变更。
func (m *MockAuthority) ReplaceZone(msgs ...*Message) {
	m.zone = make(map[cacheKey]*Message)
	for _, msg := range msgs {
		m.Add(msg)
	}
}

// QueryCount 返回累计收到的查询次数。
func (m *MockAuthority) QueryCount() int { return m.queries }

// Query 实现 Authority。未配置的查询返回 ServFail，
// 保证缓存逻辑不缓存该响应从而每次都会重新查询。
func (m *MockAuthority) Query(name string, qtype RType) *Message {
	m.queries++
	if msg, ok := m.zone[cacheKey{NormalizeName(name), qtype}]; ok {
		return cloneMessage(msg)
	}
	return &Message{Name: name, QType: qtype, RCode: RCodeServFail}
}

func cloneMessage(msg *Message) *Message {
	cp := *msg
	cp.Answer = append([]RR(nil), msg.Answer...)
	cp.Authority = append([]RR(nil), msg.Authority...)
	return &cp
}
