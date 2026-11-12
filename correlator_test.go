package dataeng

import (
	"errors"
	"math"
	"math/big"
	"sync"
	"testing"
)

func mustNew(t *testing.T, d int64) *Correlator {
	t.Helper()
	c, err := NewCorrelatorInt64(d)
	if err != nil {
		t.Fatalf("NewCorrelatorInt64(%d): %v", d, err)
	}
	return c
}

// 交付按 A 时间、再按 A 的 ID 字节序全局排序（跨 key）。
func TestDeliveryOrdering(t *testing.T) {
	c := mustNew(t, 100)
	ingestAll(t, c,
		Event{Key: "x", Type: TypeA, ID: "a3", Time: 10},
		Event{Key: "x", Type: TypeB, ID: "b3", Time: 11},
		Event{Key: "y", Type: TypeA, ID: "a2", Time: 1},
		Event{Key: "y", Type: TypeB, ID: "b2", Time: 2},
		Event{Key: "z", Type: TypeA, ID: "a1", Time: 1},
		Event{Key: "z", Type: TypeB, ID: "b1", Time: 2},
	)
	got := c.End()
	wantIDs := []string{"a1", "a2", "a3"}
	if len(got) != 3 {
		t.Fatalf("期望 3 条结果，got=%v", got)
	}
	for i, r := range got {
		if r.AID != wantIDs[i] {
			t.Fatalf("位置 %d 期望 %s，got=%v", i, wantIDs[i], got)
		}
	}
}

// 幂等：同 ID 同内容重复投递无害；同 ID 异内容被拒绝且状态不变。
func TestIdempotencyAndConflict(t *testing.T) {
	c := mustNew(t, 10)
	e := Event{Key: "k", Type: TypeA, ID: "a", Time: 0}
	if err := c.Ingest(e); err != nil {
		t.Fatal(err)
	}
	if err := c.Ingest(e); err != nil {
		t.Fatalf("重复同内容事件应幂等，got=%v", err)
	}
	conflicts := []Event{
		{Key: "other", Type: TypeA, ID: "a", Time: 0},
		{Key: "k", Type: TypeB, ID: "a", Time: 0},
		{Key: "k", Type: TypeA, ID: "a", Time: 1},
	}
	for _, bad := range conflicts {
		if err := c.Ingest(bad); !errors.Is(err, ErrDuplicateConflict) {
			t.Fatalf("异内容事件 %+v 应返回 ErrDuplicateConflict，got=%v", bad, err)
		}
	}
	if err := c.Ingest(Event{Key: "k", Type: TypeB, ID: "b", Time: 5}); err != nil {
		t.Fatal(err)
	}
	got := c.End()
	if len(got) != 1 || got[0].AID != "a" || got[0].BID != "b" {
		t.Fatalf("冲突拒绝须保持状态不变，期望 a->b，got=%v", got)
	}
}

// 违约与参数校验。
func TestRejectionsAndValidation(t *testing.T) {
	if _, err := NewCorrelator(nil); !errors.Is(err, ErrInvalidD) {
		t.Fatalf("nil D 应返回 ErrInvalidD，got=%v", err)
	}
	if _, err := NewCorrelator(big.NewInt(-1)); !errors.Is(err, ErrInvalidD) {
		t.Fatalf("负 D 应返回 ErrInvalidD，got=%v", err)
	}
	if _, err := NewCorrelatorInt64(-1); !errors.Is(err, ErrInvalidD) {
		t.Fatalf("负 D(int64) 应返回 ErrInvalidD，got=%v", err)
	}
	c := mustNew(t, 10)
	if err := c.Ingest(Event{Key: "k", Type: EventType(99), ID: "x", Time: 0}); !errors.Is(err, ErrUnknownType) {
		t.Fatalf("非法类型应返回 ErrUnknownType，got=%v", err)
	}
	if err := c.Ingest(Event{Key: "k", Type: TypeA, ID: "", Time: 0}); !errors.Is(err, ErrEmptyID) {
		t.Fatalf("空 ID 应返回 ErrEmptyID，got=%v", err)
	}
	if err := c.AdvanceWatermark(big.NewInt(5)); err != nil {
		t.Fatal(err)
	}
	if err := c.AdvanceWatermark(big.NewInt(5)); !errors.Is(err, ErrWatermarkBackwards) {
		t.Fatalf("水位持平应返回 ErrWatermarkBackwards，got=%v", err)
	}
	if err := c.AdvanceWatermark(big.NewInt(4)); !errors.Is(err, ErrWatermarkBackwards) {
		t.Fatalf("水位回退应返回 ErrWatermarkBackwards，got=%v", err)
	}
	c.End()
	if err := c.Ingest(Event{Key: "k", Type: TypeA, ID: "a", Time: 99}); !errors.Is(err, ErrClosed) {
		t.Fatalf("结束后 Ingest 应返回 ErrClosed，got=%v", err)
	}
	if err := c.AdvanceWatermark(big.NewInt(100)); !errors.Is(err, ErrClosed) {
		t.Fatalf("结束后 AdvanceWatermark 应返回 ErrClosed，got=%v", err)
	}
	if got := c.End(); len(got) != 0 {
		t.Fatalf("重复 End 应返回空，got=%v", got)
	}
	if !c.Closed() {
		t.Fatal("Closed 应为 true")
	}
}

// int64 边界时间与大窗口：数学整数运算不溢出，水位用大整数推进。
// 未显式推进水位前，任意 int64 时间的事件都不应被判迟到。
func TestNegativeTimeBeforeFirstWatermark(t *testing.T) {
	c := mustNew(t, 10)
	ingestAll(t, c,
		Event{Key: "k", Type: TypeA, ID: "a", Time: math.MinInt64},
		Event{Key: "k", Type: TypeB, ID: "b", Time: math.MinInt64 + 5},
	)
	got := c.End()
	if len(got) != 1 || got[0].AID != "a" || got[0].BID != "b" {
		t.Fatalf("未设水位时负时间事件应正常关联，got=%v", got)
	}
}

// int64 边界时间与大窗口：数学整数运算不溢出，水位用大整数推进。
func TestInt64OverflowWithBigInt(t *testing.T) {
	d := new(big.Int).SetInt64(math.MaxInt64)
	c, err := NewCorrelator(d)
	if err != nil {
		t.Fatal(err)
	}
	ingestAll(t, c,
		Event{Key: "k", Type: TypeA, ID: "a", Time: math.MaxInt64},
		Event{Key: "k", Type: TypeB, ID: "b", Time: math.MaxInt64}, // 同时间，不严格晚于 A
	)
	// A+D = 2*MaxInt64，远超 int64；用数学整数表示的水位推进到其上界之后。
	upper := new(big.Int).Add(big.NewInt(math.MaxInt64), d)
	w := new(big.Int).Add(upper, big.NewInt(1))
	if err := c.AdvanceWatermark(w); err != nil {
		t.Fatalf("大整数水位推进失败: %v", err)
	}
	if got := c.Drain(); len(got) != 0 {
		t.Fatalf("同时间 B 不满足严格晚于 A，不应输出，got=%v", got)
	}
}

// 并发冒烟测试：多 goroutine 并发摄入、推进水位与 Drain 不应触发数据竞争。
func TestConcurrentAccess(t *testing.T) {
	c := mustNew(t, 100)
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				base := g*100 + i
				_ = c.Ingest(Event{
					Key:  "k",
					Type: EventType(i % 3),
					ID:   idName(base),
					Time: int64(i),
				})
				_ = c.AdvanceWatermark(big.NewInt(int64(-1000 + base)))
				_ = c.Drain()
			}
		}(g)
	}
	wg.Wait()
	_ = c.End()
}

// 迟到的首个 B：水位先确定“无 B”，之后到达的 B 违约被拒绝，A 不输出。
func TestLateFirstBRejected(t *testing.T) {
	c := mustNew(t, 10)
	if err := c.Ingest(Event{Key: "k", Type: TypeA, ID: "a", Time: 0}); err != nil {
		t.Fatal(err)
	}
	if err := c.AdvanceWatermark(big.NewInt(11)); err != nil {
		t.Fatal(err)
	}
	if got := c.Drain(); len(got) != 0 {
		t.Fatalf("无 B 时不应交付，got=%v", got)
	}
	err := c.Ingest(Event{Key: "k", Type: TypeB, ID: "b", Time: 10})
	if !errors.Is(err, ErrLateEvent) {
		t.Fatalf("迟到 B 应返回 ErrLateEvent，got=%v", err)
	}
	if got := c.End(); len(got) != 0 {
		t.Fatalf("被拒绝的 B 不可参与匹配，got=%v", got)
	}
}

// B 乱序但在确定前到达，仍能完成匹配。
func TestOutOfOrderBArrivesBeforeDetermination(t *testing.T) {
	c := mustNew(t, 10)
	if err := c.Ingest(Event{Key: "k", Type: TypeB, ID: "b", Time: 5}); err != nil {
		t.Fatal(err)
	}
	if err := c.Ingest(Event{Key: "k", Type: TypeA, ID: "a", Time: 0}); err != nil {
		t.Fatal(err)
	}
	if err := c.AdvanceWatermark(big.NewInt(11)); err != nil {
		t.Fatal(err)
	}
	got := c.Drain()
	if len(got) != 1 || got[0].AID != "a" || got[0].BID != "b" {
		t.Fatalf("期望 a->b，got=%v", got)
	}
}

// 时间相同的候选 B 按 ID 字节序选最小者。
func TestTieBreakByIDBytes(t *testing.T) {
	c := mustNew(t, 10)
	ingestAll(t, c,
		Event{Key: "k", Type: TypeA, ID: "a", Time: 0},
		Event{Key: "k", Type: TypeB, ID: "b-z", Time: 5},
		Event{Key: "k", Type: TypeB, ID: "b-a", Time: 5},
		Event{Key: "k", Type: TypeB, ID: "b-m", Time: 5},
	)
	got := c.End()
	if len(got) != 1 || got[0].BID != "b-a" {
		t.Fatalf("时间平局应取 ID 字节序最小的 b-a，got=%v", got)
	}
}

// 同一 B 可被多个 A 复用，交付按 A 时间排序。
func TestBReused(t *testing.T) {
	c := mustNew(t, 100)
	ingestAll(t, c,
		Event{Key: "k", Type: TypeA, ID: "a1", Time: 0},
		Event{Key: "k", Type: TypeA, ID: "a2", Time: 1},
		Event{Key: "k", Type: TypeB, ID: "b", Time: 10},
	)
	got := c.End()
	if len(got) != 2 {
		t.Fatalf("期望两个 A 复用同一 B，got=%v", got)
	}
	for _, r := range got {
		if r.BID != "b" {
			t.Fatalf("期望复用 B b，got=%v", r)
		}
	}
	if got[0].AID != "a1" || got[1].AID != "a2" {
		t.Fatalf("交付应按 A 时间排序，got=%v", got)
	}
}

// C 只抑制同 key 的匹配。
func TestCScopedByKey(t *testing.T) {
	c := mustNew(t, 10)
	ingestAll(t, c,
		Event{Key: "k1", Type: TypeA, ID: "a", Time: 0},
		Event{Key: "k1", Type: TypeB, ID: "b", Time: 5},
		Event{Key: "k2", Type: TypeC, ID: "c", Time: 2},
	)
	got := c.End()
	if len(got) != 1 || got[0].AID != "a" {
		t.Fatalf("跨 key 的 C 不应抑制，got=%v", got)
	}
}

func ingestAll(t *testing.T, c *Correlator, evs ...Event) {
	t.Helper()
	for _, e := range evs {
		if err := c.Ingest(e); err != nil {
			t.Fatalf("Ingest(%+v): %v", e, err)
		}
	}
}

// 基本 A→B 匹配与窗口边界：B 时间须严格大于 A 且不晚于 A+D。
func TestBasicMatchingAndWindow(t *testing.T) {
	c := mustNew(t, 10)
	ingestAll(t, c,
		Event{Key: "k", Type: TypeA, ID: "a1", Time: 0},
		Event{Key: "k", Type: TypeB, ID: "b1", Time: 5},  // 窗口内
		Event{Key: "k", Type: TypeB, ID: "b2", Time: 10}, // 恰好 A+D，仍合格
		Event{Key: "k", Type: TypeB, ID: "b3", Time: 11}, // 超出窗口
		Event{Key: "k", Type: TypeA, ID: "a2", Time: 100},
	)
	if got := c.Drain(); len(got) != 0 {
		t.Fatalf("水位推进前不应交付，got=%v", got)
	}
	if err := c.AdvanceWatermark(big.NewInt(11)); err != nil {
		t.Fatalf("AdvanceWatermark: %v", err)
	}
	got := c.Drain()
	if len(got) != 1 || got[0].AID != "a1" || got[0].BID != "b1" || got[0].BTime != 5 {
		t.Fatalf("W=11 严格大于 a1+D=10，应交付 a1->b1，got=%v", got)
	}
	if err := c.AdvanceWatermark(big.NewInt(111)); err != nil {
		t.Fatalf("AdvanceWatermark: %v", err)
	}
	if got := c.Drain(); len(got) != 0 {
		t.Fatalf("已交付结果不应重复出现，got=%v", got)
	}
	if rest := c.End(); len(rest) != 0 {
		t.Fatalf("a2 无合格 B 不应输出，got=%v", rest)
	}
}

// 闭区间两端的 C 都抑制匹配，区间外的 C 不抑制。
func TestBoundaryC(t *testing.T) {
	cases := []struct {
		name string
		ct   int64
		want bool
	}{
		{"c-before-a", -1, true}, // C 早于 A，不在闭区间内
		{"c-at-a", 0, false},
		{"c-between", 4, false},
		{"c-at-b", 5, false},
		{"c-after-b", 6, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := mustNew(t, 10)
			ingestAll(t, c,
				Event{Key: "k", Type: TypeA, ID: "a", Time: 0},
				Event{Key: "k", Type: TypeB, ID: "b", Time: 5},
				Event{Key: "k", Type: TypeC, ID: "x", Time: tc.ct},
			)
			got := c.End()
			if tc.want && len(got) != 1 {
				t.Fatalf("期望输出 a->b，got=%v", got)
			}
			if !tc.want && len(got) != 0 {
				t.Fatalf("期望被 C 抑制，got=%v", got)
			}
		})
	}
}
