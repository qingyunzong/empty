package stats

import (
	"fmt"
	"math/rand"
	"reflect"
	"sync"
	"testing"
)

func snapGroupIDs(snaps []Snapshot) []string {
	var ids []string
	for _, s := range snaps {
		ids = append(ids, s.Group)
	}
	return ids
}

func TestMedianWindow(t *testing.T) {
	s := New(3)
	for i := 1; i <= 6; i++ {
		s.Upsert(Event{ID: fmt.Sprintf("e%d", i), Owner: "u1", Time: int64(i), Score: float64(i * 10)})
	}
	snap, ok := s.Snapshot("u1")
	if !ok {
		t.Fatal("snapshot missing")
	}
	// 最近 3 个事件分数为 40,50,60，中位数 50。
	if snap.Total != 6 || snap.Window != 3 || snap.Median != 50 {
		t.Fatalf("got %+v, want Total=6 Window=3 Median=50", snap)
	}

	// 窗口为偶数时取中间两项平均：最近 4 个为 30,40,50,60 -> 45。
	s2 := New(4)
	for i := 1; i <= 6; i++ {
		s2.Upsert(Event{ID: fmt.Sprintf("e%d", i), Owner: "u1", Time: int64(i), Score: float64(i * 10)})
	}
	if snap := mustSnap(t, s2, "u1"); snap.Median != 45 {
		t.Fatalf("even window median = %v, want 45", snap.Median)
	}

	// 事件按 (业务时间, ID) 排序，与插入顺序无关。
	s3 := New(2)
	s3.Upsert(Event{ID: "b", Owner: "u", Time: 5, Score: 1})
	s3.Upsert(Event{ID: "a", Owner: "u", Time: 5, Score: 100})
	s3.Upsert(Event{ID: "c", Owner: "u", Time: 1, Score: 7})
	// 排序后 c(1) a(5) b(5)，最近 2 个为 a,b -> (100+1)/2。
	if snap := mustSnap(t, s3, "u"); snap.Median != 50.5 {
		t.Fatalf("median = %v, want 50.5", snap.Median)
	}
}

func mustSnap(t *testing.T, s *Store, user string) Snapshot {
	t.Helper()
	snap, ok := s.Snapshot(user)
	if !ok {
		t.Fatalf("snapshot for %q missing", user)
	}
	return snap
}

func TestCorrectionMovesOwner(t *testing.T) {
	s := New(2)
	s.Upsert(Event{ID: "x", Owner: "alice", Time: 1, Score: 10})
	s.Upsert(Event{ID: "y", Owner: "alice", Time: 2, Score: 20})

	// 更正：事件 x 改属 bob，并修改分数。
	affected := s.Upsert(Event{ID: "x", Owner: "bob", Time: 1, Score: 99})
	got := snapGroupIDs(affected)
	want := []string{"alice", "bob"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("affected groups = %v, want %v", got, want)
	}
	if snap := mustSnap(t, s, "alice"); snap.Total != 1 || snap.Median != 20 {
		t.Fatalf("alice = %+v, want Total=1 Median=20", snap)
	}
	if snap := mustSnap(t, s, "bob"); snap.Total != 1 || snap.Median != 99 {
		t.Fatalf("bob = %+v, want Total=1 Median=99", snap)
	}

	// 原地更正（属主不变）只影响一个组。
	affected = s.Upsert(Event{ID: "y", Owner: "alice", Time: 3, Score: 30})
	if got := snapGroupIDs(affected); !reflect.DeepEqual(got, []string{"alice"}) {
		t.Fatalf("affected = %v, want [alice]", got)
	}
	if snap := mustSnap(t, s, "alice"); snap.Total != 1 || snap.Median != 30 {
		t.Fatalf("alice = %+v, want Total=1 Median=30", snap)
	}
}

func TestMergeDedupAndIsolation(t *testing.T) {
	s := New(10)
	s.Upsert(Event{ID: "shared", Owner: "u1", Time: 1, Score: 10})
	s.Upsert(Event{ID: "only1", Owner: "u1", Time: 2, Score: 20})
	// 同一业务事件被别名 u2 重复上报，内容一致。
	s.Inject(Event{ID: "shared", Owner: "u2", Time: 1, Score: 10})
	s.Upsert(Event{ID: "only2", Owner: "u2", Time: 3, Score: 30})
	// u3 也上报了 shared，但分数冲突。
	s.Inject(Event{ID: "shared", Owner: "u3", Time: 1, Score: 77})

	snaps := s.Merge("u1", "u2", "u3")
	if len(snaps) != 1 || snaps[0].Group != "u1" {
		t.Fatalf("merge snaps = %+v", snaps)
	}
	snap := snaps[0]
	// shared 去重为 1 条，加 only1、only2 共 3 条。
	if snap.Total != 3 {
		t.Fatalf("merged total = %d, want 3", snap.Total)
	}
	if !reflect.DeepEqual(snap.Members, []string{"u1", "u2", "u3"}) {
		t.Fatalf("members = %v", snap.Members)
	}
	// u3 的冲突副本被隔离。
	iso := s.Isolated("u1")
	if len(iso) != 1 || iso[0].Owner != "u3" || iso[0].Score != 77 {
		t.Fatalf("isolated = %+v", iso)
	}
	// 中位数基于保留事件：10,20,30 -> 20。
	if snap.Median != 20 {
		t.Fatalf("median = %v, want 20", snap.Median)
	}
}

func TestSplitRestoresSnapshots(t *testing.T) {
	s := New(3)
	s.Upsert(Event{ID: "a1", Owner: "u1", Time: 1, Score: 10})
	s.Upsert(Event{ID: "a2", Owner: "u1", Time: 2, Score: 20})
	s.Upsert(Event{ID: "b1", Owner: "u2", Time: 1, Score: 30})
	s.Inject(Event{ID: "a1", Owner: "u2", Time: 1, Score: 10}) // 重复上报
	s.Inject(Event{ID: "c1", Owner: "u3", Time: 5, Score: 50})

	before := map[string]Snapshot{}
	for _, u := range []string{"u1", "u2", "u3"} {
		before[u] = mustSnap(t, s, u)
	}

	s.Merge("u1", "u2")
	s.Merge("u1", "u3") // 嵌套归并：来源应展平为 u1/u2/u3 三组
	if snap := mustSnap(t, s, "u1"); snap.Total != 4 {
		t.Fatalf("merged total = %d, want 4", snap.Total)
	}

	snaps, ok := s.Split("u2")
	if !ok {
		t.Fatal("split failed")
	}
	if got := snapGroupIDs(snaps); !reflect.DeepEqual(got, []string{"u1", "u2", "u3"}) {
		t.Fatalf("restored groups = %v", got)
	}
	// 历史快照保持：拆分后与归并前完全一致。
	for u, want := range before {
		if got := mustSnap(t, s, u); !reflect.DeepEqual(got, want) {
			t.Fatalf("user %s: got %+v, want %+v", u, got, want)
		}
	}
	// 再次拆分应失败（已回到未归并状态）。
	if _, ok := s.Split("u1"); ok {
		t.Fatal("second split should fail")
	}
}

// checkInvariants 校验归属索引与序统计索引的一致性。
func checkInvariants(t *testing.T, s *Store) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, g := range s.groups {
		if g.id != g.sortedMembers()[0] {
			t.Errorf("group id %q != min member %q", g.id, g.sortedMembers()[0])
		}
		for m := range g.members {
			if s.userG[m] != g {
				t.Errorf("userG[%q] points elsewhere", m)
			}
		}
		seen := map[string]bool{}
		for i, e := range g.live {
			if i > 0 && !lessEvent(g.live[i-1], e) {
				t.Errorf("group %q: live not sorted at %d", g.id, i)
			}
			if seen[e.ID] {
				t.Errorf("group %q: duplicate live id %q", g.id, e.ID)
			}
			seen[e.ID] = true
			if _, ok := g.members[e.Owner]; !ok {
				t.Errorf("group %q: live event %q owner %q not a member", g.id, e.ID, e.Owner)
			}
		}
		suppIDs := map[string]bool{}
		for _, sp := range g.supp {
			if _, ok := g.members[sp.Owner]; !ok {
				t.Errorf("group %q: suppressed event %q owner %q not a member", g.id, sp.ID, sp.Owner)
			}
			suppIDs[sp.ID] = true
		}
		for id := range suppIDs {
			if !seen[id] {
				t.Errorf("group %q: suppressed id %q without live copy", g.id, id)
			}
		}
	}
	for u, g := range s.userG {
		if _, ok := g.members[u]; !ok {
			t.Errorf("user %q not in its group", u)
		}
	}
	// 归属索引：每个权威事件的副本必须在其属主组内为保留事件。
	for id, owner := range s.canon {
		g := s.userG[owner]
		if g == nil {
			t.Errorf("canon owner %q of %q has no group", owner, id)
			continue
		}
		l, ok := g.findLive(id)
		if !ok || l.Owner != owner {
			t.Errorf("canon event %q not live in owner %q's group", id, owner)
		}
	}
}

func compareWithRef(t *testing.T, s *Store, r *refStore, users []string, ctx string) {
	t.Helper()
	for _, u := range users {
		got, gotOK := s.Snapshot(u)
		want, wantOK := r.snapshot(u)
		if gotOK != wantOK {
			t.Fatalf("%s: user %q ok=%v, ref ok=%v", ctx, u, gotOK, wantOK)
		}
		if !gotOK {
			continue
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: user %q snapshot\n got %+v\nwant %+v", ctx, u, got, want)
		}
		gotIso, wantIso := s.Isolated(u), r.isolated(u)
		if !reflect.DeepEqual(gotIso, wantIso) {
			t.Fatalf("%s: user %q isolated\n got %+v\nwant %+v", ctx, u, gotIso, wantIso)
		}
	}
}

func TestRandomAgainstFullSort(t *testing.T) {
	users := []string{"u0", "u1", "u2", "u3", "u4", "u5"}
	for seed := int64(1); seed <= 30; seed++ {
		rng := rand.New(rand.NewSource(seed))
		s := New(4)
		r := newRefStore(4)
		ctx := func(step int, op string) string {
			return fmt.Sprintf("seed=%d step=%d op=%s", seed, step, op)
		}
		randUser := func() string { return users[rng.Intn(len(users))] }
		randEvent := func() Event {
			return Event{
				ID:    fmt.Sprintf("e%d", rng.Intn(20)),
				Owner: randUser(),
				Time:  int64(rng.Intn(50)),
				Score: float64(rng.Intn(100)),
			}
		}
		for step := 0; step < 400; step++ {
			var op string
			switch rng.Intn(10) {
			case 0, 1, 2, 3:
				e := randEvent()
				op = fmt.Sprintf("upsert %+v", e)
				s.Upsert(e)
				r.upsert(e)
			case 4, 5:
				e := randEvent()
				op = fmt.Sprintf("inject %+v", e)
				s.Inject(e)
				r.inject(e)
			case 6, 7:
				n := 2 + rng.Intn(2)
				set := map[string]bool{}
				var us []string
				for len(us) < n {
					u := randUser()
					if !set[u] {
						set[u] = true
						us = append(us, u)
					}
				}
				op = fmt.Sprintf("merge %v", us)
				s.Merge(us...)
				r.merge(us...)
			case 8:
				u := randUser()
				op = fmt.Sprintf("split %q", u)
				gotOK := false
				if _, ok := s.Split(u); ok {
					gotOK = true
				}
				if wantOK := r.split(u); gotOK != wantOK {
					t.Fatalf("%s: split ok=%v, ref ok=%v", ctx(step, op), gotOK, wantOK)
				}
			case 9:
				// 归并后立即拆分：历史快照必须保持。
				// 仅对无归并历史的组做还原检查（拆分会回到最初来源，
				// 即撤销整条归并链，而非只撤销本次归并）。
				u1, u2 := randUser(), randUser()
				for u2 == u1 {
					u2 = randUser()
				}
				op = fmt.Sprintf("merge+split %q %q", u1, u2)
				s.mu.Lock()
				virgin := true
				for _, u := range []string{u1, u2} {
					if g, ok := s.userG[u]; ok && g.origins != nil {
						virgin = false
					}
				}
				s.mu.Unlock()
				if !virgin {
					s.Merge(u1, u2)
					r.merge(u1, u2)
					s.Split(u1)
					r.split(u1)
					break
				}
				before := map[string]Snapshot{}
				for _, u := range users {
					if snap, ok := s.Snapshot(u); ok {
						before[u] = snap
					}
				}
				s.Merge(u1, u2)
				r.merge(u1, u2)
				s.Split(u1)
				r.split(u1)
				for _, u := range users {
					want, had := before[u]
					got, ok := s.Snapshot(u)
					if !had {
						// 归并会为未知用户建空组；拆分后允许存在但须为空。
						if ok && (got.Total != 0 || len(got.Members) != 1 || got.Members[0] != u) {
							t.Fatalf("%s: user %q unexpected %+v", ctx(step, op), u, got)
						}
						continue
					}
					if !ok {
						t.Fatalf("%s: user %q disappeared", ctx(step, op), u)
					}
					if !reflect.DeepEqual(got, want) {
						t.Fatalf("%s: user %q snapshot not restored\n got %+v\nwant %+v",
							ctx(step, op), u, got, want)
					}
				}
			}
			compareWithRef(t, s, r, users, ctx(step, op))
			checkInvariants(t, s)
		}
	}
}

func TestConcurrentAtomic(t *testing.T) {
	s := New(5)
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 300; i++ {
				e := Event{
					ID:    fmt.Sprintf("w%d-e%d", w, i%40),
					Owner: fmt.Sprintf("u%d", (i+w)%6),
					Time:  int64(i),
					Score: float64(i % 97),
				}
				s.Upsert(e)
				if i%7 == 0 {
					s.Snapshot(fmt.Sprintf("u%d", i%6))
				}
				if i%11 == 0 {
					s.Merge(fmt.Sprintf("u%d", i%6), fmt.Sprintf("u%d", (i+1)%6))
				}
				if i%13 == 0 {
					s.Split(fmt.Sprintf("u%d", i%6))
				}
			}
		}(w)
	}
	wg.Wait()
	// 并发下每个操作都原子地维护两类索引；最终状态必须满足全部不变式。
	checkInvariants(t, s)
}
