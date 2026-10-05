package streamjoin

import (
	"fmt"
	"math/rand"
	"testing"
)

func pairKey(r Record) [2]string {
	var k [2]string
	if r.Left != nil {
		k[0] = r.Left.ID
	}
	if r.Right != nil {
		k[1] = r.Right.ID
	}
	return k
}

// netCounts 校验输出序列前缀合法（撤回必有先前插入），并返回净多重集。
func netCounts(t *testing.T, recs []Record) map[[2]string]int {
	t.Helper()
	counts := map[[2]string]int{}
	for i, r := range recs {
		k := pairKey(r)
		if r.Retract {
			if counts[k] <= 0 {
				t.Fatalf("记录 %d：撤回未插入过的记录 %v", i, k)
			}
			counts[k]--
		} else {
			counts[k]++
		}
	}
	return counts
}

// batchJoin 全量（批式）区间连接，作为对照基准。
func batchJoin(d int64, left, right map[string]Event) map[[2]string]int {
	want := map[[2]string]int{}
	matchedL := map[string]bool{}
	matchedR := map[string]bool{}
	for _, l := range left {
		for _, r := range right {
			if matched(d, l, r) {
				want[[2]string{l.ID, r.ID}] = 1
				matchedL[l.ID] = true
				matchedR[r.ID] = true
			}
		}
	}
	for id := range left {
		if !matchedL[id] {
			want[[2]string{id, ""}] = 1
		}
	}
	for id := range right {
		if !matchedR[id] {
			want[[2]string{"", id}] = 1
		}
	}
	return want
}

func TestBoundaryInclusive(t *testing.T) {
	j := New(10)
	j.Add(Left, Event{ID: "l1", Key: "k", Time: 100})
	j.Add(Right, Event{ID: "r1", Key: "k", Time: 90})  // 差 10，含边界，匹配
	j.Add(Right, Event{ID: "r2", Key: "k", Time: 89})  // 差 11，不匹配
	j.Add(Right, Event{ID: "r3", Key: "k", Time: 110}) // 差 10，含边界，匹配
	j.Add(Right, Event{ID: "r4", Key: "x", Time: 100}) // 键不同，不匹配
	recs := j.Drain()

	got := map[[2]string]bool{}
	for _, r := range recs {
		if r.Retract {
			t.Fatalf("不应出现撤回：%+v", r)
		}
		got[pairKey(r)] = true
	}
	if !got[[2]string{"l1", "r1"}] || !got[[2]string{"l1", "r3"}] {
		t.Fatalf("边界等于 d 的匹配缺失：%v", got)
	}
	if got[[2]string{"l1", "r2"}] || got[[2]string{"l1", "r4"}] {
		t.Fatalf("差 11 或键不同不应匹配：%v", got)
	}
	if len(recs) != 2 {
		t.Fatalf("期望 2 条匹配输出，实际 %d", len(recs))
	}
}

func TestWatermarkGatesUnmatched(t *testing.T) {
	j := New(10)
	j.Add(Left, Event{ID: "l1", Key: "k", Time: 50})
	if n := len(j.Drain()); n != 0 {
		t.Fatalf("水位未推进不应输出，实际 %d 条", n)
	}
	j.Advance(Right, 60) // 等于候选最晚时刻 50+10，未超过，不输出
	if n := len(j.Drain()); n != 0 {
		t.Fatalf("水位等于 t+d 不应输出未匹配行，实际 %d 条", n)
	}
	j.Advance(Right, 61) // 超过，输出未匹配行
	recs := j.Drain()
	if len(recs) != 1 || recs[0].Retract || recs[0].Left == nil || recs[0].Left.ID != "l1" || recs[0].Right != nil {
		t.Fatalf("期望 1 条左未匹配行，实际 %+v", recs)
	}
	j.Advance(Right, 1000) // 不重复输出
	if n := len(j.Drain()); n != 0 {
		t.Fatalf("未匹配行重复输出 %d 条", n)
	}
}

func TestLateMatchRetractsSolo(t *testing.T) {
	j := New(10)
	j.Add(Left, Event{ID: "l1", Key: "k", Time: 50})
	j.Advance(Right, 61)
	j.Drain() // 已输出 l1 未匹配行

	j.Add(Right, Event{ID: "r1", Key: "k", Time: 55}) // 迟到数据
	recs := j.Drain()
	if len(recs) != 2 {
		t.Fatalf("期望撤回+新匹配共 2 条，实际 %+v", recs)
	}
	if !recs[0].Retract || recs[0].Left == nil || recs[0].Right != nil {
		t.Fatalf("第 1 条应为 l1 未匹配行的撤回：%+v", recs[0])
	}
	if recs[1].Retract || recs[1].Left.ID != "l1" || recs[1].Right.ID != "r1" {
		t.Fatalf("第 2 条应为 (l1,r1) 匹配：%+v", recs[1])
	}
}

func TestCorrectionRetracts(t *testing.T) {
	j := New(10)
	j.Add(Left, Event{ID: "l1", Key: "k", Time: 0, Value: "v0"})
	j.Add(Right, Event{ID: "r1", Key: "k", Time: 5})
	j.Drain() // (l1,r1)

	// 更正 l1：先撤回旧匹配，再按新版本重新匹配（此刻无匹配也无未匹配行）
	j.Add(Left, Event{ID: "l1", Key: "k", Time: 100, Value: "v1"})
	recs := j.Drain()
	if len(recs) != 1 || !recs[0].Retract || recs[0].Left.ID != "l1" || recs[0].Right.ID != "r1" {
		t.Fatalf("更正应先撤回旧匹配：%+v", recs)
	}

	j.Add(Right, Event{ID: "r2", Key: "k", Time: 108}) // 与新版本差 8，匹配
	recs = j.Drain()
	if len(recs) != 1 || recs[0].Retract || recs[0].Left.ID != "l1" || recs[0].Right.ID != "r2" {
		t.Fatalf("更正后应输出新匹配 (l1,r2)：%+v", recs)
	}

	// 更正已输出未匹配行的事件：先撤回未匹配行（独立键 z，确保无匹配）
	j.Add(Left, Event{ID: "l2", Key: "z", Time: 0})
	j.Advance(Right, 100)
	recs = j.Drain()
	if len(recs) != 1 || recs[0].Retract || recs[0].Left.ID != "l2" || recs[0].Right != nil {
		t.Fatalf("水位超过后应输出 l2 未匹配行：%+v", recs)
	}
	j.Add(Left, Event{ID: "l2", Key: "k", Time: 105})
	recs = j.Drain()
	if len(recs) != 2 || !recs[0].Retract || recs[0].Left.ID != "l2" ||
		recs[1].Retract || recs[1].Left.ID != "l2" || recs[1].Right.ID != "r2" {
		t.Fatalf("更正已输出未匹配行的事件应先撤回再发新匹配：%+v", recs)
	}
}

func TestOneToMany(t *testing.T) {
	j := New(10)
	j.Add(Left, Event{ID: "l1", Key: "k", Time: 100})
	j.Add(Left, Event{ID: "l2", Key: "k", Time: 105})
	j.Add(Right, Event{ID: "r1", Key: "k", Time: 100}) // 同时匹配 l1、l2
	j.Add(Right, Event{ID: "r2", Key: "k", Time: 98})  // 同时匹配 l1、l2
	recs := j.Drain()
	got := netCounts(t, recs)
	for _, want := range [][2]string{{"l1", "r1"}, {"l2", "r1"}, {"l1", "r2"}, {"l2", "r2"}} {
		if got[want] != 1 {
			t.Fatalf("缺少一对多匹配 %v：%v", want, got)
		}
	}
	if len(got) != 4 {
		t.Fatalf("期望 4 条匹配，实际 %v", got)
	}
}

// TestOutOfOrderVsBatch 乱序 + 更正的流式结果，与全量区间连接对照。
func TestOutOfOrderVsBatch(t *testing.T) {
	for seed := int64(1); seed <= 20; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			runOutOfOrderVsBatch(t, seed)
		})
	}
}

func runOutOfOrderVsBatch(t *testing.T, seed int64) {
	const d = 10
	rng := rand.New(rand.NewSource(seed))
	keys := []string{"a", "b", "c"}

	finalL := map[string]Event{}
	finalR := map[string]Event{}

	// op 携带目标事件 ID，用于保证更正排在被更正事件之后。
	type op struct {
		id string
		fn func(*Joiner)
	}
	var ops []op
	addEvent := func(side Side, e Event) {
		ops = append(ops, op{e.ID, func(j *Joiner) { j.Add(side, e) }})
	}
	for i := 0; i < 40; i++ {
		e := Event{ID: fmt.Sprintf("l%d", i), Key: keys[rng.Intn(len(keys))],
			Time: int64(rng.Intn(100)), Value: fmt.Sprintf("lv%d", i)}
		finalL[e.ID] = e
		addEvent(Left, e)
	}
	for i := 0; i < 40; i++ {
		e := Event{ID: fmt.Sprintf("r%d", i), Key: keys[rng.Intn(len(keys))],
			Time: int64(rng.Intn(100)), Value: fmt.Sprintf("rv%d", i)}
		finalR[e.ID] = e
		addEvent(Right, e)
	}
	// 水位推进操作混入事件流（Advance 取最大值，乱序安全）
	for _, w := range []int64{10, 30, 50, 70, 90, 110} {
		w := w
		ops = append(ops, op{"", func(j *Joiner) { j.Advance(Left, w); j.Advance(Right, w) }})
	}
	rng.Shuffle(len(ops), func(a, b int) { ops[a], ops[b] = ops[b], ops[a] })
	// 更正：同 ID 重发，改变时间/键/值；须插到该 ID 已有操作之后，
	// 否则流式侧后到的旧版本会覆盖更正（与全量基准的最终版本不一致）。
	var corrections []op
	for i := 0; i < 12; i++ {
		if rng.Intn(2) == 0 {
			id := fmt.Sprintf("l%d", rng.Intn(40))
			e := Event{ID: id, Key: keys[rng.Intn(len(keys))],
				Time: int64(rng.Intn(100)), Value: "fixed"}
			finalL[id] = e
			corrections = append(corrections, op{id, func(j *Joiner) { j.Add(Left, e) }})
		} else {
			id := fmt.Sprintf("r%d", rng.Intn(40))
			e := Event{ID: id, Key: keys[rng.Intn(len(keys))],
				Time: int64(rng.Intn(100)), Value: "fixed"}
			finalR[id] = e
			corrections = append(corrections, op{id, func(j *Joiner) { j.Add(Right, e) }})
		}
	}
	for _, c := range corrections {
		last := -1
		for i, o := range ops {
			if o.id == c.id {
				last = i
			}
		}
		at := last + 1 + rng.Intn(len(ops)-last) // 插入位置 ∈ (last, len]
		ops = append(ops[:at], append([]op{c}, ops[at:]...)...)
	}
	// 最终冲刷：水位推到无穷，所有未匹配行必须输出
	flush := int64(1) << 60
	ops = append(ops, op{"", func(j *Joiner) { j.Advance(Left, flush); j.Advance(Right, flush) }})

	j := New(d)
	var all []Record
	for _, op := range ops {
		op.fn(j)
		all = append(all, j.Drain()...)
	}

	got := netCounts(t, all)
	for k, v := range got {
		if v == 0 {
			delete(got, k) // 已撤回的记录净次数为 0，不计入最终结果
			continue
		}
		if v != 1 {
			t.Fatalf("记录 %v 净次数异常：%d", k, v)
		}
	}
	want := batchJoin(d, finalL, finalR)
	if len(got) != len(want) {
		t.Fatalf("结果条数不符：流式 %d，全量 %d", len(got), len(want))
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("记录 %v：流式净次数 %d，全量期望 %d", k, got[k], v)
		}
	}
}
