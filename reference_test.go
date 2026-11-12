package dataeng

import (
	"math/big"
	"math/rand"
	"sort"
	"testing"
)

// referenceCompute 是规格的全量排序参考实现：先收集全部事件，按 key 分组、
// 按 (时间, ID 字节序) 排序，再对每个 A 顺序判定首个合格 B 与闭区间内的 C。
// 它不关心到达顺序与水位，代表 End（正无穷水位）后的确定结果。
func referenceCompute(events []Event, d *big.Int) []Result {
	byKey := make(map[string][]Event)
	for _, e := range events {
		byKey[e.Key] = append(byKey[e.Key], e)
	}
	var results []Result
	for key, evs := range byKey {
		sort.SliceStable(evs, func(i, j int) bool {
			if evs[i].Time != evs[j].Time {
				return evs[i].Time < evs[j].Time
			}
			return evs[i].ID < evs[j].ID
		})
		for _, a := range evs {
			if a.Type != TypeA {
				continue
			}
			aTime := big.NewInt(a.Time)
			limit := new(big.Int).Add(aTime, d)
			var b *Event
			for i := range evs {
				candidate := &evs[i]
				if candidate.Type != TypeB {
					continue
				}
				cTime := big.NewInt(candidate.Time)
				if cTime.Cmp(aTime) <= 0 || cTime.Cmp(limit) > 0 {
					continue
				}
				b = candidate
				break
			}
			if b == nil {
				continue
			}
			suppressed := false
			for _, e := range evs {
				if e.Type != TypeC {
					continue
				}
				eTime := big.NewInt(e.Time)
				if eTime.Cmp(aTime) >= 0 && eTime.Cmp(big.NewInt(b.Time)) <= 0 {
					suppressed = true
					break
				}
			}
			if suppressed {
				continue
			}
			results = append(results, Result{
				Key:   key,
				AID:   a.ID,
				BID:   b.ID,
				ATime: a.Time,
				BTime: b.Time,
			})
		}
	}
	sort.Slice(results, func(i, j int) bool {
		if results[i].ATime != results[j].ATime {
			return results[i].ATime < results[j].ATime
		}
		return results[i].AID < results[j].AID
	})
	return results
}

func assertSortedByA(t *testing.T, rs []Result) {
	t.Helper()
	if !sort.SliceIsSorted(rs, func(i, j int) bool {
		if rs[i].ATime != rs[j].ATime {
			return rs[i].ATime < rs[j].ATime
		}
		return rs[i].AID < rs[j].AID
	}) {
		t.Fatalf("交付结果未按 (A 时间, A ID) 排序: %v", rs)
	}
}

// TestReferenceProperty 以随机乱序事件流和随机水位推进，对照全量排序参考
// 实现校验最终交付集合，并覆盖迟到首 B、边界 C、幂等重放等路径。
func TestReferenceProperty(t *testing.T) {
	for _, seed := range []int64{1, 2, 3, 7, 42, 99} {
		t.Run("", func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			d := big.NewInt(int64(rng.Intn(8))) // 小窗口制造边界与超时
			c, err := NewCorrelator(d)
			if err != nil {
				t.Fatal(err)
			}

			const n = 60
			var all []Event
			for i := 0; i < n; i++ {
				all = append(all, Event{
					Key:  []string{"k1", "k2", "k3"}[rng.Intn(3)],
					Type: []EventType{TypeA, TypeB, TypeC}[rng.Intn(3)],
					ID:   idName(i),
					Time: int64(rng.Intn(41) - 20),
				})
			}
			order := rng.Perm(n)

			wm := big.NewInt(1) // 首次显式水位；事件时间范围 [-20,20]
			accepted := make(map[int]bool)
			seen := make(map[string]bool)
			var acceptedEvents []Event
			deliveredA := make(map[string]bool)
			var streamed []Result

			idx := 0
			for idx < n {
				if rng.Intn(3) == 0 {
					wm = new(big.Int).Add(wm, big.NewInt(int64(1+rng.Intn(4))))
					if err := c.AdvanceWatermark(new(big.Int).Set(wm)); err != nil {
						t.Fatalf("AdvanceWatermark(%s): %v", wm, err)
					}
					batch := c.Drain()
					assertSortedByA(t, batch)
					for _, r := range batch {
						if deliveredA[r.AID] {
							t.Fatalf("A %s 被重复交付", r.AID)
						}
						deliveredA[r.AID] = true
						streamed = append(streamed, r)
					}
					continue
				}
				e := all[order[idx]]
				idx++
				err := c.Ingest(e)
				switch {
				case err == nil:
					if !seen[e.ID] {
						accepted[order[idx-1]] = true
						seen[e.ID] = true
						acceptedEvents = append(acceptedEvents, e)
					}
				case err == ErrLateEvent:
					// 迟到事件必须确实早于水位，且不进入参考集合。
					if big.NewInt(e.Time).Cmp(wm) >= 0 {
						t.Fatalf("事件 %+v 未迟到却被拒绝 (wm=%s)", e, wm)
					}
				default:
					t.Fatalf("Ingest(%+v) 意外错误: %v", e, err)
				}
				// 随机幂等重放一条已接受事件。
				if rng.Intn(6) == 0 && len(acceptedEvents) > 0 {
					replay := acceptedEvents[rng.Intn(len(acceptedEvents))]
					if err := c.Ingest(replay); err != nil {
						t.Fatalf("幂等重放 %+v 失败: %v", replay, err)
					}
				}
			}

			var kept []Event
			for i, e := range all {
				if accepted[i] {
					kept = append(kept, e)
				}
			}
			want := referenceCompute(kept, d)
			final := c.End()
			assertSortedByA(t, final)
			for _, r := range final {
				if deliveredA[r.AID] {
					t.Fatalf("A %s 在 End 中被重复交付", r.AID)
				}
				deliveredA[r.AID] = true
				streamed = append(streamed, r)
			}
			sort.Slice(streamed, func(i, j int) bool {
				if streamed[i].ATime != streamed[j].ATime {
					return streamed[i].ATime < streamed[j].ATime
				}
				return streamed[i].AID < streamed[j].AID
			})
			if len(streamed) != len(want) {
				t.Fatalf("交付数量 %d 与参考 %d 不一致", len(streamed), len(want))
			}
			for i := range want {
				if streamed[i] != want[i] {
					t.Fatalf("位置 %d 不匹配: got=%+v want=%+v", i, streamed[i], want[i])
				}
			}
		})
	}
}

func idName(i int) string {
	return "id-" + string(rune('a'+i%26)) + string(rune('a'+(i/26)%26)) + string(rune('a'+(i/676)%26))
}
