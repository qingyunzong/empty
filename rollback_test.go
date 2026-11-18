package formal

import (
	"context"
	"errors"
	"math"
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"
)

// pin 把一次 Assignment 与它被路由时的版本绑定，供交错测试验证“在途钉住”。
type pin struct {
	id         string
	assignment *Assignment
	released   bool
}

// TestRollbackInterleave 穷举“路由 / 完成 / 切换 / 回滚”交错的随机序列，断言：
//   - 在途请求始终保持被路由时的版本（回滚只影响新请求）；
//   - Release 幂等，重复完成不会重复计数；
//   - 每一代配置内部的正式计数都符合朴素比例分配且总和守恒；
//   - 在途计数之和恒等于未 Release 的请求数。
func TestRollbackInterleave(t *testing.T) {
	rng := rand.New(rand.NewSource(20261119))
	configs := []Config{
		{Versions: []Version{{ID: "v1", Weight: 90}, {ID: "v2", Role: RoleCanary, Weight: 10}}},
		{Versions: []Version{{ID: "v1", Weight: 50}, {ID: "v2", Role: RoleCanary, Weight: 50}}},
		{Versions: []Version{{ID: "v1", Weight: 10}, {ID: "v2", Role: RoleCanary, Weight: 90}}},
		{Versions: []Version{{ID: "v3", Weight: 100}}},
	}

	for iter := 0; iter < 400; iter++ {
		s, err := NewSplitter(configs[rng.Intn(len(configs))])
		if err != nil {
			t.Fatal(err)
		}

		var pins []*pin
		var outstanding int64
		genRouted := map[int]map[string]int64{}
		genIDs := map[int][]string{}
		genWeights := map[int][]int{}
		captureGen := func(gen int) {
			if _, ok := genIDs[gen]; ok {
				return
			}
			ids, ws := primaryWeights(s.CurrentConfig())
			genIDs[gen] = ids
			genWeights[gen] = ws
			genRouted[gen] = map[string]int64{}
		}
		captureGen(s.Generation())

		const steps = 150
		for step := 0; step < steps; step++ {
			switch rng.Intn(4) {
			case 0, 1: // 新请求
				a, _ := s.Route()
				gen := s.Generation()
				captureGen(gen)
				genRouted[gen][a.VersionID()]++
				pins = append(pins, &pin{id: a.VersionID(), assignment: a})
				outstanding++

			case 2: // 完成一个在途请求（含重复 Release 验证幂等）
				if len(pins) == 0 {
					continue
				}
				p := pins[rng.Intn(len(pins))]
				if p.released {
					continue
				}
				if p.assignment.VersionID() != p.id {
					t.Fatalf("iter=%d in-flight version changed: was %s now %s",
						iter, p.id, p.assignment.VersionID())
				}
				before := s.Stats().InFlight[p.id]
				p.assignment.Release()
				p.assignment.Release()
				if got := s.Stats().InFlight[p.id]; got != before-1 {
					t.Fatalf("iter=%d step=%d release count drift: %d->%d",
						iter, step, before, got)
				}
				p.released = true
				outstanding--

			case 3: // 切换或回滚
				next := configs[rng.Intn(len(configs))]
				if rng.Intn(2) == 0 {
					err = s.Rollback(next)
				} else {
					err = s.UpdateConfig(next)
				}
				if err != nil {
					t.Fatalf("iter=%d update: %v", iter, err)
				}
				captureGen(s.Generation())
			}

			// 不变量：在途总量与未完成请求数一致，且无负值。
			var inFlightTotal int64
			for _, v := range s.Stats().InFlight {
				if v < 0 {
					t.Fatalf("iter=%d negative in-flight count", iter)
				}
				inFlightTotal += v
			}
			if inFlightTotal != outstanding {
				t.Fatalf("iter=%d step=%d in-flight=%d outstanding=%d",
					iter, step, inFlightTotal, outstanding)
			}
			// 不变量：所有在途 Assignment 的版本在切换后依旧不变。
			for _, p := range pins {
				if !p.released && p.assignment.VersionID() != p.id {
					t.Fatalf("iter=%d pinned version mutated: %s -> %s",
						iter, p.id, p.assignment.VersionID())
				}
			}
		}

		// 收尾：释放全部在途请求，在途计数归零。
		for _, p := range pins {
			if !p.released {
				p.assignment.Release()
			}
		}
		for id, v := range s.Stats().InFlight {
			if v != 0 {
				t.Fatalf("iter=%d in-flight %s=%d after drain", iter, id, v)
			}
		}

		// 逐代核对：每代内部分配与朴素比例分配一致，且代际计数互不重复。
		var grandTotal int64
		for gen, routed := range genRouted {
			ids := genIDs[gen]
			ws := genWeights[gen]
			var genTotal int64
			counts := make([]int64, len(ids))
			for i, id := range ids {
				counts[i] = routed[id]
				genTotal += routed[id]
			}
			exact := naiveExact(ws, int(genTotal))
			for i := range ids {
				dev := math.Abs(float64(counts[i]) - exact[i])
				if dev >= 2 {
					t.Fatalf("iter=%d gen=%d %s count=%d exact=%.2f deviation=%.2f",
						iter, gen, ids[i], counts[i], exact[i], dev)
				}
			}
			grandTotal += genTotal
		}
		var primaryTotal int64
		for _, v := range s.Stats().Primary {
			primaryTotal += v
		}
		if primaryTotal != grandTotal {
			t.Fatalf("iter=%d primary total=%d but generation totals=%d",
				iter, primaryTotal, grandTotal)
		}
	}
}

// recordingHandler 记录每个版本收到的请求，并可按版本注入错误/panic。
type recordingHandler struct {
	mu          sync.Mutex
	primary     []string
	shadows     []string
	failShadow  map[string]bool
	panicShadow map[string]bool
}

func (h *recordingHandler) Handle(_ context.Context, versionID string, _ any) (any, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.panicShadow[versionID] {
		panic("boom: " + versionID)
	}
	if h.failShadow[versionID] {
		return nil, errors.New("shadow failure: " + versionID)
	}
	if versionID == "shadow" || versionID == "shadow2" {
		h.shadows = append(h.shadows, versionID)
		return "shadow-resp:" + versionID, nil
	}
	h.primary = append(h.primary, versionID)
	return "resp:" + versionID, nil
}

func testConfig() Config {
	return Config{Versions: []Version{
		{ID: "stable", Role: RoleStable, Weight: 70},
		{ID: "canary", Role: RoleCanary, Weight: 30},
		{ID: "shadow", Role: RoleShadow, Weight: 0},
		{ID: "shadow2", Role: RoleShadow, Weight: 0},
	}}
}

// TestDispatcherShadowIsolation 验证影子流量不影响正式响应：
// 影子报错或 panic 时，正式响应与错误保持原样，影子只累计影子计数。
func TestDispatcherShadowIsolation(t *testing.T) {
	s, err := NewSplitter(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	h := &recordingHandler{failShadow: map[string]bool{"shadow": true}, panicShadow: map[string]bool{"shadow2": true}}
	d := NewDispatcher(s, h)

	const n = 100
	for i := 0; i < n; i++ {
		dec := d.Dispatch(context.Background(), "req")
		if dec.Err != nil {
			t.Fatalf("primary must not see shadow errors: %v", dec.Err)
		}
		if dec.Response != "resp:"+dec.PrimaryID {
			t.Fatalf("primary response tampered: %v", dec.Response)
		}
		if dec.ShadowErr["shadow"] == nil || dec.ShadowErr["shadow2"] == nil {
			t.Fatalf("shadow errors must be captured separately: %v", dec.ShadowErr)
		}
		dec.Assignment.Release()
	}

	stats := s.Stats()
	var primaryTotal int64
	for _, id := range []string{"stable", "canary"} {
		primaryTotal += stats.Primary[id]
	}
	if primaryTotal != n {
		t.Fatalf("primary total=%d want %d", primaryTotal, n)
	}
	for _, id := range []string{"shadow", "shadow2"} {
		if stats.Shadow[id] != n {
			t.Fatalf("shadow %s=%d want %d", id, stats.Shadow[id], n)
		}
		if _, ok := stats.Primary[id]; ok {
			t.Fatalf("shadow %s must not appear in primary stats", id)
		}
	}
	h.mu.Lock()
	if len(h.primary) != n {
		t.Fatalf("handler primary calls=%d want %d", len(h.primary), n)
	}
	if len(h.shadows) != 0 {
		t.Fatalf("failing/panicking shadows must not record success: %d", len(h.shadows))
	}
	h.mu.Unlock()
}

// TestDispatcherAsyncShadow 验证异步影子模式：Close 后全部影子调用完成，
// 且正式响应始终即时返回、不受影子影响。
func TestDispatcherAsyncShadow(t *testing.T) {
	s, err := NewSplitter(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	h := &recordingHandler{}
	d := NewDispatcher(s, h, WithAsyncShadow())

	const n = 200
	for i := 0; i < n; i++ {
		dec := d.Dispatch(context.Background(), "req")
		if dec.Response != "resp:"+dec.PrimaryID || dec.ShadowErr != nil {
			t.Fatalf("async dispatch must return primary only: %+v", dec)
		}
		dec.Assignment.Release()
	}
	d.Close()

	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.primary) != n {
		t.Fatalf("primary calls=%d want %d", len(h.primary), n)
	}
	if len(h.shadows) != 2*n {
		t.Fatalf("shadow calls=%d want %d", len(h.shadows), 2*n)
	}
}

// TestConcurrentRouting 在 race 检测下并发路由/完成/切换，验证守恒与无数据竞争。
func TestConcurrentRouting(t *testing.T) {
	s, err := NewSplitter(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	const goroutines = 16
	const perG = 200
	var wg sync.WaitGroup
	var routed int64
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perG; i++ {
				a, _ := s.Route()
				atomic.AddInt64(&routed, 1)
				a.Release()
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		alt := Config{Versions: []Version{
			{ID: "stable", Weight: 40},
			{ID: "canary", Role: RoleCanary, Weight: 60},
			{ID: "shadow", Role: RoleShadow, Weight: 0},
		}}
		for i := 0; i < 20; i++ {
			_ = s.Rollback(alt)
			_ = s.Rollback(testConfig())
		}
	}()
	wg.Wait()

	var primaryTotal, inFlightTotal int64
	stats := s.Stats()
	for _, v := range stats.Primary {
		primaryTotal += v
	}
	for _, v := range stats.InFlight {
		inFlightTotal += v
	}
	if primaryTotal != goroutines*perG || atomic.LoadInt64(&routed) != primaryTotal {
		t.Fatalf("primary=%d routed=%d want=%d", primaryTotal, routed, goroutines*perG)
	}
	if inFlightTotal != 0 {
		t.Fatalf("in-flight=%d after all releases", inFlightTotal)
	}
}
