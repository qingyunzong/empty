package frameindex

import (
	"math/rand"
	"testing"
)

// 随机图性质测试：对随机生成的帧图（含随机缺失参考、随机环、
// 解码时间与显示时间独立打散），每个随机区间都要通过全图 DFS 模型核对。
// 证书的可签发性独立判定：闭包内存在与解码序矛盾的依赖边（含环）时
// 必须拒绝；否则必须签发、可核验，且模拟解码不违反依赖。
func TestRandomGraphsAgainstModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 500; trial++ {
		n := 1 + rng.Intn(12)
		ix := NewIndex()

		decodeTimes := rng.Perm(n) // 解码时间随机打散
		displayTimes := rng.Perm(n)
		ids := make([]string, n)
		for i := 0; i < n; i++ {
			ids[i] = string(rune('A' + i))
		}
		for i := 0; i < n; i++ {
			var refs []string
			for j := 0; j < n; j++ {
				if j != i && rng.Float64() < 0.25 {
					refs = append(refs, ids[j])
				}
			}
			if rng.Float64() < 0.1 { // 10% 概率引用不存在的帧
				refs = append(refs, "ghost")
			}
			if err := ix.Add(Frame{
				ID:          ids[i],
				DecodeTime:  int64(decodeTimes[i]),
				DisplayTime: int64(displayTimes[i]),
				Refs:        refs,
			}); err != nil {
				t.Fatalf("trial %d: %v", trial, err)
			}
		}

		start := int64(rng.Intn(n))
		end := start + int64(rng.Intn(n))
		p := ix.SeekInterval(start, end)

		if err := ix.CheckAgainstModel(p); err != nil {
			t.Fatalf("trial %d interval [%d,%d]: %v", trial, start, end, err)
		}

		// 独立期望：闭包内是否有依赖边与解码序矛盾（环是其特例）。
		order := ix.DecodeOrder()
		pos := make(map[string]int, len(order))
		for i, f := range order {
			pos[f.ID] = i
		}
		inClosure := make(map[string]bool, len(p.Closure))
		for _, id := range p.Closure {
			inClosure[id] = true
		}
		expectFail := false
		for _, id := range p.Closure {
			f, _ := ix.Get(id)
			for _, ref := range f.Refs {
				if inClosure[ref] && pos[ref] > pos[id] {
					expectFail = true
				}
			}
		}

		cert, err := ix.Certify(p)
		if expectFail {
			if err == nil {
				t.Fatalf("trial %d: decode-order-violating plan must not certify", trial)
			}
			continue
		}
		if err != nil {
			t.Fatalf("trial %d: Certify: %v", trial, err)
		}
		if err := ix.Verify(cert, p); err != nil {
			t.Fatalf("trial %d: Verify: %v", trial, err)
		}
		// 模拟解码：按证书顺序，依赖必先于使用者出现。
		decoded := map[string]bool{}
		for _, id := range cert.Order {
			f, _ := ix.Get(id)
			for _, ref := range f.Refs {
				if inClosure[ref] && !decoded[ref] {
					t.Fatalf("trial %d: %q decoded before reference %q", trial, id, ref)
				}
			}
			decoded[id] = true
		}
		// 无矛盾时证书必须覆盖整个闭包。
		if len(cert.Order) != len(p.Closure) {
			t.Fatalf("trial %d: cert covers %d frames, closure has %d",
				trial, len(cert.Order), len(p.Closure))
		}
	}
}

// 验证“显示时间升序不是合法解码序”：
// 若误用显示时间排序，B 帧会排在其参考 P 帧之前。
func TestDisplayOrderIsNotDecodeOrder(t *testing.T) {
	ix := NewIndex()
	mustAdd(t, ix,
		Frame{ID: "I", DecodeTime: 0, DisplayTime: 0},
		Frame{ID: "P", DecodeTime: 1, DisplayTime: 2, Refs: []string{"I"}},
		Frame{ID: "B", DecodeTime: 2, DisplayTime: 1, Refs: []string{"I", "P"}},
	)
	order := ix.DecodeOrder()
	got := []string{order[0].ID, order[1].ID, order[2].ID}
	want := []string{"I", "P", "B"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("decode order = %v, want %v (display order would be I,B,P)", got, want)
		}
	}
}
