package windowagg

import (
	"math"
	"math/rand"
	"sort"
	"strconv"
	"testing"
)

func windowMap(ws []Window) map[int64]Window {
	m := make(map[int64]Window, len(ws))
	for _, w := range ws {
		m[w.Start] = w
	}
	return m
}

func TestHalfOpenWindowBoundaries(t *testing.T) {
	a := NewAggregator(10, 0)
	for _, e := range []Event{
		{ID: "a", Time: 0, Value: 1},
		{ID: "b", Time: 9, Value: 2},
		{ID: "c", Time: 10, Value: 4}, // 边界：归入下一个窗口
		{ID: "d", Time: 19, Value: 8},
		{ID: "e", Time: 20, Value: 16},
	} {
		if !a.Add(e) {
			t.Fatalf("event %+v rejected", e)
		}
	}
	got := a.Windows()
	if len(got) != 3 {
		t.Fatalf("want 3 windows, got %d: %+v", len(got), got)
	}
	w0 := got[0]
	if w0.Start != 0 || w0.End != 10 || w0.Count != 2 || w0.Sum != 3 {
		t.Errorf("window [0,10) = %+v", w0)
	}
	w1 := got[1]
	if w1.Start != 10 || w1.End != 20 || w1.Count != 2 || w1.Sum != 12 {
		t.Errorf("window [10,20) = %+v", w1)
	}
	w2 := got[2]
	if w2.Start != 20 || w2.End != 30 || w2.Count != 1 || w2.Sum != 16 {
		t.Errorf("window [20,30) = %+v", w2)
	}
}

func TestNegativeEventTimes(t *testing.T) {
	a := NewAggregator(10, 100)
	a.Add(Event{ID: "a", Time: -1, Value: 1})
	a.Add(Event{ID: "b", Time: -10, Value: 2})
	a.Add(Event{ID: "c", Time: -11, Value: 4})
	got := windowMap(a.Windows())
	if w := got[-10]; w.Count != 2 || w.Sum != 3 {
		t.Errorf("window [-10,0) = %+v", w)
	}
	if w := got[-20]; w.Count != 1 || w.Sum != 4 {
		t.Errorf("window [-20,-10) = %+v", w)
	}
}

func TestWatermarkOnlyIncreases(t *testing.T) {
	a := NewAggregator(10, 1000)
	want := []int64{100, 100, 200, 200, 200}
	for i, tm := range []int64{100, 50, 200, 30, 150} {
		a.Add(Event{ID: strconv.Itoa(i), Time: tm, Value: 1})
		wm, ok := a.Watermark()
		if !ok || wm != want[i] {
			t.Fatalf("after time %d: watermark = %d, want %d", tm, wm, want[i])
		}
	}
}

func TestLatenessBound(t *testing.T) {
	a := NewAggregator(10, 5)
	a.Add(Event{ID: "a", Time: 100, Value: 1}) // 水位 = 100
	if !a.Add(Event{ID: "b", Time: 95, Value: 1}) {
		t.Error("t=95 (== watermark-L) should be accepted")
	}
	if a.Add(Event{ID: "c", Time: 94, Value: 1}) {
		t.Error("t=94 (< watermark-L) should be rejected")
	}
	if a.Rejected() != 1 {
		t.Errorf("rejected = %d, want 1", a.Rejected())
	}
}

func TestCorrectionSameWindow(t *testing.T) {
	a := NewAggregator(10, 100)
	a.Add(Event{ID: "a", Time: 3, Value: 10})
	a.Add(Event{ID: "b", Time: 4, Value: 1})
	a.Add(Event{ID: "a", Time: 5, Value: 7}) // 更正：撤销 10，计入 7
	got := windowMap(a.Windows())
	w := got[0]
	if w.Count != 2 || w.Sum != 8 {
		t.Errorf("window = %+v, want count 2 sum 8", w)
	}
	// 修订序号：a 计入(1)、b 计入(2)、a 撤销(3)、a 重新计入(4)
	if w.Revision != 4 {
		t.Errorf("revision = %d, want 4", w.Revision)
	}
}

func TestCorrectionMovesWindow(t *testing.T) {
	a := NewAggregator(10, 100)
	a.Add(Event{ID: "a", Time: 3, Value: 10})
	a.Add(Event{ID: "a", Time: 13, Value: 5}) // 更正后落入另一窗口
	got := a.Windows()
	if len(got) != 1 {
		t.Fatalf("want 1 non-empty window, got %+v", got)
	}
	if got[0].Start != 10 || got[0].Count != 1 || got[0].Sum != 5 {
		t.Errorf("window = %+v", got[0])
	}
	if got[0].Revision != 1 { // 撤销记在原窗口，新窗口仅计入一次
		t.Errorf("revision = %d, want 1", got[0].Revision)
	}
}

func TestCorrectionUnknownID(t *testing.T) {
	a := NewAggregator(10, 100)
	if !a.Add(Event{ID: "ghost", Time: 3, Value: 9}) {
		t.Fatal("correction of unknown ID should be accepted as new event")
	}
	got := windowMap(a.Windows())
	if got[0].Count != 1 || got[0].Sum != 9 {
		t.Errorf("window = %+v", got[0])
	}
}

func TestLateCorrectionRejected(t *testing.T) {
	a := NewAggregator(10, 5)
	a.Add(Event{ID: "a", Time: 100, Value: 10}) // 水位 = 100
	if a.Add(Event{ID: "a", Time: 90, Value: 99}) {
		t.Fatal("late correction should be rejected")
	}
	got := windowMap(a.Windows())
	w := got[100]
	if w.Count != 1 || w.Sum != 10 {
		t.Errorf("old contribution must be kept, window = %+v", w)
	}
}

// checkStreamingMatchesRecompute 按给定顺序流式摄入事件，
// 校验水位单调，并将流式结果与存活事件的全量重算对照。
func checkStreamingMatchesRecompute(t *testing.T, windowSize, lateness int64, delivery []Event) {
	t.Helper()
	agg := NewAggregator(windowSize, lateness)
	lastWM := int64(math.MinInt64)
	accepted := 0
	for _, e := range delivery {
		if agg.Add(e) {
			accepted++
		}
		wm, _ := agg.Watermark()
		if wm < lastWM {
			t.Fatalf("watermark decreased: %d -> %d", lastWM, wm)
		}
		lastWM = wm
	}
	if agg.Rejected()+accepted != len(delivery) {
		t.Fatalf("accepted %d + rejected %d != %d", accepted, agg.Rejected(), len(delivery))
	}

	got := agg.Windows()
	want := Recompute(windowSize, agg.Live())
	if len(got) != len(want) {
		t.Fatalf("window count: streaming %d, recompute %d", len(got), len(want))
	}
	for i := range want {
		g, w := got[i], want[i]
		if g.Start != w.Start || g.End != w.End || g.Count != w.Count || g.Sum != w.Sum {
			t.Errorf("window %d: streaming %+v != recompute %+v", i, g, w)
		}
	}
	for _, g := range got {
		if g.Revision < uint64(g.Count) {
			t.Errorf("window %d: revision %d < count %d", g.Start, g.Revision, g.Count)
		}
	}
	t.Logf("delivered=%d accepted=%d rejected=%d windows=%d",
		len(delivery), accepted, agg.Rejected(), len(got))
}

func TestOutOfOrderVsFullRecompute(t *testing.T) {
	const (
		windowSize = 10
		nEvents    = 5000
		nIDs       = 400 // ID 远少于事件数，产生大量更正
	)

	t.Run("BoundedDisorder", func(t *testing.T) {
		const lateness = 350
		rng := rand.New(rand.NewSource(42))
		events := make([]Event, nEvents)
		tm := int64(-10000)
		for i := range events {
			tm += int64(rng.Intn(8)) // 平均步进小于窗口大小
			events[i] = Event{
				ID:    "id-" + strconv.Itoa(rng.Intn(nIDs)),
				Time:  tm + int64(rng.Intn(201)-100), // 抖动 ±100
				Value: float64(rng.Intn(2001) - 1000),
			}
		}
		// 有界乱序：每条事件仅在 ±40 个位置内交换。
		delivery := make([]Event, nEvents)
		copy(delivery, events)
		for i := range delivery {
			lo := max(0, i-40)
			hi := min(nEvents-1, i+40)
			j := lo + rng.Intn(hi-lo+1)
			delivery[i], delivery[j] = delivery[j], delivery[i]
		}
		// 把 20 条最早的事件挪到投递末尾，保证产生迟到拒绝。
		order := make([]int, nEvents)
		for i := range order {
			order[i] = i
		}
		sort.Slice(order, func(x, y int) bool { return delivery[order[x]].Time < delivery[order[y]].Time })
		moved := make([]bool, nEvents)
		for _, idx := range order[:20] {
			moved[idx] = true
		}
		head := make([]Event, 0, nEvents)
		var tail []Event
		for i, e := range delivery {
			if moved[i] {
				tail = append(tail, e)
			} else {
				head = append(head, e)
			}
		}
		delivery = append(head, tail...)

		checkStreamingMatchesRecompute(t, windowSize, lateness, delivery)
	})

	t.Run("FullyShuffled", func(t *testing.T) {
		const lateness = 25
		rng := rand.New(rand.NewSource(7))
		events := make([]Event, nEvents)
		for i := range events {
			events[i] = Event{
				ID:    "id-" + strconv.Itoa(rng.Intn(nIDs)),
				Time:  int64(rng.Intn(20000)) - 5000, // 含负时间
				Value: float64(rng.Intn(2001) - 1000),
			}
		}
		// 完全打乱投递顺序，大量事件因超出迟到界限被拒。
		delivery := make([]Event, nEvents)
		copy(delivery, events)
		rng.Shuffle(nEvents, func(i, j int) {
			delivery[i], delivery[j] = delivery[j], delivery[i]
		})

		agg := NewAggregator(windowSize, lateness)
		for _, e := range delivery {
			agg.Add(e)
		}
		if agg.Rejected() == 0 {
			t.Fatal("fully shuffled delivery produced no rejections; lateness path untested")
		}
		checkStreamingMatchesRecompute(t, windowSize, lateness, delivery)
	})
}
