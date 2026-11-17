package formal_test

import (
	"testing"
	"time"

	formal "example.org/dlks/formal/q10166"
)

func soaRR(name string, ttl, minimum uint32) formal.RR {
	return formal.RR{
		Name: name,
		Type: formal.TypeSOA,
		TTL:  ttl,
		RData: formal.SOARData{
			NS:      "ns.example.",
			MBox:    "admin.example.",
			Minimum: minimum,
		},
	}
}

func aRR(name string, ttl uint32, addr string) formal.RR {
	return formal.RR{Name: name, Type: formal.TypeA, TTL: ttl, RData: formal.AData{Addr: addr}}
}

func aaaaRR(name string, ttl uint32, addr string) formal.RR {
	return formal.RR{Name: name, Type: formal.TypeAAAA, TTL: ttl, RData: formal.AAAAData{Addr: addr}}
}

func cnameRR(name string, ttl uint32, target string) formal.RR {
	return formal.RR{Name: name, Type: formal.TypeCNAME, TTL: ttl, RData: formal.CNAMERData{Target: target}}
}

func assertHit(t *testing.T, msg *formal.Message) *formal.Message {
	t.Helper()
	if msg == nil {
		t.Fatal("期望缓存命中，实际未命中")
	}
	return msg
}

func assertMiss(t *testing.T, msg *formal.Message) {
	t.Helper()
	if msg != nil {
		t.Fatalf("期望缓存未命中，实际命中: %+v", msg)
	}
}

// 正向记录：TTL 内命中且不重新查询，到期后重新查询并拿到新区数据。
func TestPositiveHitAndExpiry(t *testing.T) {
	clock := formal.NewVirtualClock(time.Unix(1000, 0))
	cache := formal.NewCache(formal.WithClock(clock))
	auth := formal.NewMockAuthority()
	resolver := formal.NewResolver(cache, auth)

	auth.Add(&formal.Message{
		Name:   "host.example.",
		QType:  formal.TypeA,
		RCode:  formal.RCodeOK,
		Answer: []formal.RR{aRR("host.example.", 100, "192.0.2.1")},
	})

	first := assertHit(t, resolver.Lookup("host.example.", formal.TypeA))
	if got := first.Answer[0].RData; got != (formal.AData{Addr: "192.0.2.1"}) {
		t.Fatalf("首次查询结果错误: %v", got)
	}
	if auth.QueryCount() != 1 {
		t.Fatalf("期望 1 次权威查询，实际 %d", auth.QueryCount())
	}

	second := assertHit(t, resolver.Lookup("host.example.", formal.TypeA))
	if auth.QueryCount() != 1 {
		t.Fatalf("TTL 内应命中缓存，权威查询次数仍应为 1，实际 %d", auth.QueryCount())
	}
	if second.Answer[0].TTL != 100 {
		t.Fatalf("刚写入的剩余 TTL 应为 100，实际 %d", second.Answer[0].TTL)
	}

	// 区变更：记录地址改变。TTL 未到期前查询路径仍应看到旧数据。
	auth.ReplaceZone(&formal.Message{
		Name:   "host.example.",
		QType:  formal.TypeA,
		RCode:  formal.RCodeOK,
		Answer: []formal.RR{aRR("host.example.", 100, "198.51.100.7")},
	})
	stale := assertHit(t, resolver.Lookup("host.example.", formal.TypeA))
	if stale.Answer[0].RData != (formal.AData{Addr: "192.0.2.1"}) {
		t.Fatalf("TTL 内不应观察到区变更，实际拿到 %v", stale.Answer[0].RData)
	}

	clock.Advance(50 * time.Second)
	mid := assertHit(t, resolver.Lookup("host.example.", formal.TypeA))
	if mid.Answer[0].TTL != 50 {
		t.Fatalf("推进 50s 后剩余 TTL 应为 50，实际 %d", mid.Answer[0].TTL)
	}

	clock.Advance(50 * time.Second)
	assertMiss(t, cache.Lookup("host.example.", formal.TypeA))
	fresh := assertHit(t, resolver.Lookup("host.example.", formal.TypeA))
	if auth.QueryCount() != 2 {
		t.Fatalf("到期后应重新查询，期望 2 次权威查询，实际 %d", auth.QueryCount())
	}
	if fresh.Answer[0].RData != (formal.AData{Addr: "198.51.100.7"}) {
		t.Fatalf("重查后应观察到区变更后的新地址，实际 %v", fresh.Answer[0].RData)
	}
}

// NXDOMAIN：按名称缓存否定结果，对任意 QTYPE 生效；否定 TTL 取 min(SOA TTL, MINIMUM)。
func TestNXDOMAINNegativeCaching(t *testing.T) {
	clock := formal.NewVirtualClock(time.Unix(2000, 0))
	cache := formal.NewCache(formal.WithClock(clock))
	auth := formal.NewMockAuthority()
	resolver := formal.NewResolver(cache, auth)

	auth.Add(&formal.Message{
		Name:      "missing.example.",
		QType:     formal.TypeA,
		RCode:     formal.RCodeNXDomain,
		Authority: []formal.RR{soaRR("example.", 600, 30)},
	})

	nx := assertHit(t, resolver.Lookup("missing.example.", formal.TypeA))
	if nx.RCode != formal.RCodeNXDomain {
		t.Fatalf("期望 NXDOMAIN，实际 %d", nx.RCode)
	}
	if nx.Authority[0].TTL != 30 {
		t.Fatalf("否定 TTL 应为 min(600,30)=30，实际 %d", nx.Authority[0].TTL)
	}
	// 名称级否定对另一种 QTYPE 同样成立，且不产生新的权威查询。
	again := assertHit(t, resolver.Lookup("missing.example.", formal.TypeAAAA))
	if again.RCode != formal.RCodeNXDomain || again.QType != formal.TypeAAAA {
		t.Fatalf("NXDOMAIN 应按名称对任意 QTYPE 生效，实际 rcode=%d qtype=%d", again.RCode, again.QType)
	}
	if auth.QueryCount() != 1 {
		t.Fatalf("否定结果应跨 QTYPE 共享，期望 1 次权威查询，实际 %d", auth.QueryCount())
	}

	clock.Advance(29 * time.Second)
	assertHit(t, cache.Lookup("missing.example.", formal.TypeA))
	clock.Advance(1 * time.Second)
	assertMiss(t, cache.Lookup("missing.example.", formal.TypeA))

	// 到期后权威区已补上记录，重新查询应得到正向应答。
	auth.ReplaceZone(&formal.Message{
		Name:   "missing.example.",
		QType:  formal.TypeA,
		RCode:  formal.RCodeOK,
		Answer: []formal.RR{aRR("missing.example.", 60, "203.0.113.9")},
	})
	fixed := assertHit(t, resolver.Lookup("missing.example.", formal.TypeA))
	if fixed.RCode != formal.RCodeOK || auth.QueryCount() != 2 {
		t.Fatalf("否定 TTL 到期后应重查并得到新应答，rcode=%d 查询数=%d", fixed.RCode, auth.QueryCount())
	}
}

// SOA TTL 小于 MINIMUM 时，否定 TTL 取 SOA 自身 TTL。
func TestNegativeTTLUsesSOATTLWhenSmaller(t *testing.T) {
	clock := formal.NewVirtualClock(time.Unix(3000, 0))
	cache := formal.NewCache(formal.WithClock(clock))

	cache.Store(&formal.Message{
		Name:      "n.example.",
		QType:     formal.TypeAAAA,
		RCode:     formal.RCodeNXDomain,
		Authority: []formal.RR{soaRR("example.", 15, 300)},
	})
	msg := assertHit(t, cache.Lookup("n.example.", formal.TypeA))
	if msg.Authority[0].TTL != 15 {
		t.Fatalf("否定 TTL 应为 min(15,300)=15，实际 %d", msg.Authority[0].TTL)
	}
	clock.Advance(15 * time.Second)
	assertMiss(t, cache.Lookup("n.example.", formal.TypeA))
}

// NODATA：名称存在但请求类型无记录，按 (名称, QTYPE) 缓存，不影响其他类型。
func TestNODATAPerTypeCaching(t *testing.T) {
	clock := formal.NewVirtualClock(time.Unix(4000, 0))
	cache := formal.NewCache(formal.WithClock(clock))
	auth := formal.NewMockAuthority()
	resolver := formal.NewResolver(cache, auth)

	auth.Add(&formal.Message{
		Name:      "only-v4.example.",
		QType:     formal.TypeAAAA,
		RCode:     formal.RCodeOK,
		Authority: []formal.RR{soaRR("example.", 900, 120)},
	})
	auth.Add(&formal.Message{
		Name:   "only-v4.example.",
		QType:  formal.TypeA,
		RCode:  formal.RCodeOK,
		Answer: []formal.RR{aRR("only-v4.example.", 300, "192.0.2.8")},
	})

	nodata := assertHit(t, resolver.Lookup("only-v4.example.", formal.TypeAAAA))
	if nodata.RCode != formal.RCodeOK || len(nodata.Answer) != 0 {
		t.Fatalf("期望 NODATA（NoError 无回答），实际 %+v", nodata)
	}
	assertHit(t, resolver.Lookup("only-v4.example.", formal.TypeAAAA))
	if auth.QueryCount() != 1 {
		t.Fatalf("NODATA 第二次查询应命中缓存，实际查询数 %d", auth.QueryCount())
	}

	// 另一种类型有独立缓存条目，不受 NODATA 影响。
	positive := assertHit(t, resolver.Lookup("only-v4.example.", formal.TypeA))
	if len(positive.Answer) != 1 || auth.QueryCount() != 2 {
		t.Fatalf("A 记录应独立缓存，answer=%d 查询数=%d", len(positive.Answer), auth.QueryCount())
	}

	clock.Advance(120 * time.Second)
	assertMiss(t, cache.Lookup("only-v4.example.", formal.TypeAAAA))
	assertHit(t, cache.Lookup("only-v4.example.", formal.TypeA))
}

// 否定应答没有携带 SOA 时不得缓存（RFC 2308），每次都重新查询。
func TestNegativeWithoutSOANotCached(t *testing.T) {
	clock := formal.NewVirtualClock(time.Unix(5000, 0))
	cache := formal.NewCache(formal.WithClock(clock))

	cache.Store(&formal.Message{
		Name:  "no-soa.example.",
		QType: formal.TypeA,
		RCode: formal.RCodeNXDomain,
	})
	assertMiss(t, cache.Lookup("no-soa.example.", formal.TypeA))
	if cache.Len() != 0 {
		t.Fatalf("无 SOA 的否定结果不应写入缓存，Len=%d", cache.Len())
	}

	// SERVFAIL 同样不缓存。
	cache.Store(&formal.Message{Name: "fail.example.", QType: formal.TypeA, RCode: formal.RCodeServFail})
	assertMiss(t, cache.Lookup("fail.example.", formal.TypeA))
}

// TTL 为 0 的记录不写入缓存，保证区变更能立即被观察到。
func TestZeroTTLNotCached(t *testing.T) {
	clock := formal.NewVirtualClock(time.Unix(5500, 0))
	cache := formal.NewCache(formal.WithClock(clock))

	cache.Store(&formal.Message{
		Name:   "volatile.example.",
		QType:  formal.TypeA,
		RCode:  formal.RCodeOK,
		Answer: []formal.RR{aRR("volatile.example.", 0, "192.0.2.99")},
	})
	assertMiss(t, cache.Lookup("volatile.example.", formal.TypeA))
}

// CNAME 链：各跳 RRSet 独立到期，中间跳失效只重查受影响部分，其余跳继续命中。
func TestCNAMEChainIndependentTTL(t *testing.T) {
	clock := formal.NewVirtualClock(time.Unix(6000, 0))
	cache := formal.NewCache(formal.WithClock(clock))
	auth := formal.NewMockAuthority()
	resolver := formal.NewResolver(cache, auth)

	auth.Add(&formal.Message{
		Name:  "alias.example.",
		QType: formal.TypeA,
		RCode: formal.RCodeOK,
		Answer: []formal.RR{
			cnameRR("alias.example.", 30, "mid.example."),
			cnameRR("mid.example.", 600, "target.example."),
			aRR("target.example.", 600, "192.0.2.20"),
		},
	})

	chain := assertHit(t, resolver.Lookup("alias.example.", formal.TypeA))
	if len(chain.Answer) != 3 {
		t.Fatalf("期望 3 条回答（2 CNAME + 1 A），实际 %d", len(chain.Answer))
	}
	if auth.QueryCount() != 1 {
		t.Fatalf("期望 1 次权威查询，实际 %d", auth.QueryCount())
	}
	assertHit(t, resolver.Lookup("alias.example.", formal.TypeA))
	if auth.QueryCount() != 1 {
		t.Fatalf("完整链应命中缓存，实际查询数 %d", auth.QueryCount())
	}

	// 第一跳 30s 到期：整链未命中，但后两跳仍是有效缓存条目。
	clock.Advance(30 * time.Second)
	assertMiss(t, cache.Lookup("alias.example.", formal.TypeA))
	assertHit(t, cache.Lookup("mid.example.", formal.TypeCNAME))
	assertHit(t, cache.Lookup("target.example.", formal.TypeA))

	// 权威只重查入口名，返回新的第一跳；后续跳直接从缓存拼装，不再查权威。
	auth.Add(&formal.Message{
		Name:   "alias.example.",
		QType:  formal.TypeA,
		RCode:  formal.RCodeOK,
		Answer: []formal.RR{cnameRR("alias.example.", 30, "mid.example.")},
	})
	rebuilt := assertHit(t, resolver.Lookup("alias.example.", formal.TypeA))
	if len(rebuilt.Answer) != 3 {
		t.Fatalf("重查第一跳后应借助缓存重建完整 3 跳链，实际 %d 跳", len(rebuilt.Answer))
	}
	if rebuilt.Answer[2].RData != (formal.AData{Addr: "192.0.2.20"}) {
		t.Fatalf("末端 A 应来自未受影响的缓存条目，实际 %v", rebuilt.Answer[2].RData)
	}
	if auth.QueryCount() != 2 {
		t.Fatalf("只应重查入口名一次，期望 2 次权威查询，实际 %d", auth.QueryCount())
	}

	// 末端 A 到期时，两条 CNAME 仍然有效：只有末端结果失效。
	clock.Advance(30 * time.Second) // 刷新后的第一跳再次到期
	auth.Add(&formal.Message{
		Name:   "alias.example.",
		QType:  formal.TypeA,
		RCode:  formal.RCodeOK,
		Answer: []formal.RR{cnameRR("alias.example.", 900, "mid.example.")},
	})
	assertHit(t, resolver.Lookup("alias.example.", formal.TypeA))

	// 此刻 t=60：mid 与 target 的条目在 t=600 到期，第一跳新条目在 t=960 到期。
	clock.Advance(539 * time.Second) // t=599，末端条目仍有效
	assertHit(t, cache.Lookup("alias.example.", formal.TypeCNAME))
	assertHit(t, cache.Lookup("mid.example.", formal.TypeCNAME))
	assertHit(t, cache.Lookup("target.example.", formal.TypeA))
	assertHit(t, cache.Lookup("alias.example.", formal.TypeA))

	clock.Advance(1 * time.Second) // t=600，首写的后两跳同时到期，第一跳仍有效
	assertHit(t, cache.Lookup("alias.example.", formal.TypeCNAME))
	assertMiss(t, cache.Lookup("mid.example.", formal.TypeCNAME))
	assertMiss(t, cache.Lookup("target.example.", formal.TypeA))
	assertMiss(t, cache.Lookup("alias.example.", formal.TypeA))
}

// 链末端为 NXDOMAIN：否定结果与 CNAME RRSet 分别独立缓存。
func TestCNAMEChainToNXDOMAIN(t *testing.T) {
	clock := formal.NewVirtualClock(time.Unix(7000, 0))
	cache := formal.NewCache(formal.WithClock(clock))
	auth := formal.NewMockAuthority()
	resolver := formal.NewResolver(cache, auth)

	auth.Add(&formal.Message{
		Name:  "dead.example.",
		QType: formal.TypeA,
		RCode: formal.RCodeNXDomain,
		Answer: []formal.RR{
			cnameRR("dead.example.", 300, "gone.example."),
		},
		Authority: []formal.RR{soaRR("example.", 600, 45)},
	})

	msg := assertHit(t, resolver.Lookup("dead.example.", formal.TypeA))
	if msg.RCode != formal.RCodeNXDomain {
		t.Fatalf("期望链末端 NXDOMAIN，实际 rcode=%d", msg.RCode)
	}
	if auth.QueryCount() != 1 {
		t.Fatalf("期望 1 次权威查询，实际 %d", auth.QueryCount())
	}
	// CNAME 跳与末端否定结果都已独立缓存，第二次查询完全命中。
	assertHit(t, cache.Lookup("dead.example.", formal.TypeCNAME))
	again := assertHit(t, resolver.Lookup("dead.example.", formal.TypeA))
	if again.RCode != formal.RCodeNXDomain || auth.QueryCount() != 1 {
		t.Fatalf("链上否定结果应命中缓存，rcode=%d 查询数=%d", again.RCode, auth.QueryCount())
	}

	// 否定 TTL（45s）先于 CNAME（300s）到期：CNAME 仍在，链需要在末端重查。
	clock.Advance(45 * time.Second)
	assertHit(t, cache.Lookup("dead.example.", formal.TypeCNAME))
	assertMiss(t, cache.Lookup("gone.example.", formal.TypeA))
	assertMiss(t, cache.Lookup("dead.example.", formal.TypeA))
}

// 不同大小写共享缓存键，但返回的名称保留首次写入时的原始展示。
func TestCaseInsensitiveKeyPreservesDisplay(t *testing.T) {
	clock := formal.NewVirtualClock(time.Unix(8000, 0))
	cache := formal.NewCache(formal.WithClock(clock))
	auth := formal.NewMockAuthority()
	resolver := formal.NewResolver(cache, auth)

	auth.Add(&formal.Message{
		Name:   "Host.Example.",
		QType:  formal.TypeA,
		RCode:  formal.RCodeOK,
		Answer: []formal.RR{aRR("Host.Example.", 120, "192.0.2.30")},
	})

	// 用全小写查询名触发查询并写入缓存。
	assertHit(t, resolver.Lookup("host.example.", formal.TypeA))
	if auth.QueryCount() != 1 {
		t.Fatalf("期望 1 次权威查询，实际 %d", auth.QueryCount())
	}
	// 混用大小写再次查询，应共享同一缓存键，不产生新的权威查询。
	mixed := assertHit(t, resolver.Lookup("HoSt.ExAmPle.", formal.TypeA))
	if auth.QueryCount() != 1 {
		t.Fatalf("不同大小写应共享缓存键，实际查询数 %d", auth.QueryCount())
	}
	if mixed.Answer[0].Name != "Host.Example." {
		t.Fatalf("应答名称应保留权威原始大小写展示，实际 %q", mixed.Answer[0].Name)
	}

	// NXDOMAIN 同样按规范名共享键。
	auth.Add(&formal.Message{
		Name:      "Missing.Example.",
		QType:     formal.TypeA,
		RCode:     formal.RCodeNXDomain,
		Authority: []formal.RR{soaRR("Example.", 60, 60)},
	})
	nx := assertHit(t, resolver.Lookup("MISSING.EXAMPLE.", formal.TypeA))
	if nx.RCode != formal.RCodeNXDomain || auth.QueryCount() != 2 {
		t.Fatalf("NXDOMAIN 应按规范名缓存，rcode=%d 查询数=%d", nx.RCode, auth.QueryCount())
	}
	assertHit(t, resolver.Lookup("missing.example.", formal.TypeAAAA))
	if auth.QueryCount() != 2 {
		t.Fatalf("名称级 NXDOMAIN 应跨大小写与 QTYPE 共享，实际查询数 %d", auth.QueryCount())
	}
}

// CNAME 链中目标名称的原始大小写在缓存拼装时必须原样保留。
func TestCNAMETargetCasingPreserved(t *testing.T) {
	clock := formal.NewVirtualClock(time.Unix(9000, 0))
	cache := formal.NewCache(formal.WithClock(clock))

	cache.Store(&formal.Message{
		Name:  "alias.example.",
		QType: formal.TypeA,
		RCode: formal.RCodeOK,
		Answer: []formal.RR{
			cnameRR("alias.example.", 300, "MiD.Example."),
			aRR("mid.example.", 300, "192.0.2.40"),
		},
	})

	msg := assertHit(t, cache.Lookup("ALIAS.example.", formal.TypeA))
	if len(msg.Answer) != 2 {
		t.Fatalf("期望 2 条回答，实际 %d", len(msg.Answer))
	}
	target := msg.Answer[0].RData.(formal.CNAMERData).Target
	if target != "MiD.Example." {
		t.Fatalf("CNAME 目标应保留原始大小写，实际 %q", target)
	}
	if msg.Answer[1].Name != "mid.example." {
		t.Fatalf("末端 RR 名称应保留权威展示，实际 %q", msg.Answer[1].Name)
	}
}
