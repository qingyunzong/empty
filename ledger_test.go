package ledger

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

var t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func entry(id string, bHour, sHour int, amount int64) Entry {
	return Entry{
		ID:           id,
		BusinessTime: t0.Add(time.Duration(bHour) * time.Hour),
		SubmitTime:   t0.Add(time.Duration(sHour) * time.Hour),
		Amount:       amount,
	}
}

func mustCommit(t *testing.T, l *Ledger, b *Batch) {
	t.Helper()
	b.Lock()
	if err := l.CommitBatch(b); err != nil {
		t.Fatalf("commit batch %s: %v", b.ID, err)
	}
}

// 空前缀为 0。
func TestEmptyPrefixIsZero(t *testing.T) {
	l := New()
	s := l.Snapshot()
	for _, axis := range []Axis{AxisBusiness, AxisSubmit} {
		if got := s.Cumulative(axis, 0); got != 0 {
			t.Fatalf("axis %s: empty prefix = %d, want 0", axis, got)
		}
		if pre := s.PrefixEvidence(axis); len(pre) != 1 || pre[0] != 0 {
			t.Fatalf("axis %s: prefix evidence = %v, want [0]", axis, pre)
		}
		if got := s.FirstExceed(axis, 0); got != -1 {
			t.Fatalf("axis %s: FirstExceed on empty ledger = %d, want -1", axis, got)
		}
	}
}

// 按业务时间+ID 排序的累计与首次越界位置。
func TestCumulativeAndFirstExceed(t *testing.T) {
	l := New()
	b := NewBatch("b1")
	// 同一业务时间，靠 ID 决胜：ea < eb。
	for _, e := range []Entry{
		entry("eb", 1, 1, 40),
		entry("ea", 1, 2, 30),
		entry("e3", 2, 3, 50),
	} {
		if err := b.Add(e); err != nil {
			t.Fatal(err)
		}
	}
	mustCommit(t, l, b)

	s := l.Snapshot()
	wantPre := []int64{0, 30, 70, 120} // ea=30, eb=40, e3=50
	if got := s.PrefixEvidence(AxisBusiness); fmt.Sprint(got) != fmt.Sprint(wantPre) {
		t.Fatalf("business prefix = %v, want %v", got, wantPre)
	}
	if got := s.Cumulative(AxisBusiness, 2); got != 70 {
		t.Fatalf("cumulative(2) = %d, want 70", got)
	}
	if got := s.FirstExceed(AxisBusiness, 70); got != 3 {
		t.Fatalf("FirstExceed(70) = %d, want 3", got)
	}
	if got := s.FirstExceed(AxisBusiness, 120); got != -1 {
		t.Fatalf("FirstExceed(120) = %d, want -1 (strictly greater)", got)
	}
}

// 负费用历史：前缀证据与逐项扫描对照。
func TestNegativeExpensesMatchItemScan(t *testing.T) {
	l := New()
	b := NewBatch("neg")
	amounts := []int64{100, -250, 75, -10, -5, 300}
	for i, a := range amounts {
		if err := b.Add(entry(fmt.Sprintf("n%d", i), i, i, a)); err != nil {
			t.Fatal(err)
		}
	}
	mustCommit(t, l, b)

	s := l.Snapshot()
	for _, axis := range []Axis{AxisBusiness, AxisSubmit} {
		evidence := s.PrefixEvidence(axis)
		var running int64
		for i, e := range s.Entries(axis) {
			running += e.Amount
			if evidence[i+1] != running {
				t.Fatalf("axis %s prefix[%d] = %d, item scan = %d", axis, i+1, evidence[i+1], running)
			}
		}
		// 中间累计可为负，越界判定须如实反映。
		if got := s.FirstExceed(axis, 0); got != 1 {
			t.Fatalf("axis %s FirstExceed(0) = %d, want 1", axis, got)
		}
	}
}

// 撤销通过新增冲正批使越界点消失，且原始前缀不被修改。
func TestUndoRemovesExceedAndKeepsOriginalPrefix(t *testing.T) {
	l := New()
	b := NewBatch("b1")
	for _, e := range []Entry{
		entry("a", 1, 1, 60),
		entry("b", 2, 2, 60),
		entry("c", 3, 3, 10),
	} {
		if err := b.Add(e); err != nil {
			t.Fatal(err)
		}
	}
	mustCommit(t, l, b)

	before := l.Snapshot()
	if got := before.FirstExceed(AxisBusiness, 100); got != 2 {
		t.Fatalf("before undo: FirstExceed(100) = %d, want 2", got)
	}
	beforeEvidence := before.PrefixEvidence(AxisBusiness)

	// 撤销较早的贡献条目 a：冲正继承其业务时间并紧随其后排位，
	// 之后的累计整体回落，越界点消失。
	revID, err := l.Undo("a")
	if err != nil {
		t.Fatalf("undo: %v", err)
	}
	after := l.Snapshot()

	// 越界点消失：前缀变为 0,60,0,60,70，峰值 70 <= 100。
	if got := after.FirstExceed(AxisBusiness, 100); got != -1 {
		t.Fatalf("after undo: FirstExceed(100) = %d, want -1", got)
	}
	// 原前缀未被修改：旧快照证据原样保留（只追加账本）。
	if got := before.PrefixEvidence(AxisBusiness); fmt.Sprint(got) != fmt.Sprint(beforeEvidence) {
		t.Fatalf("old snapshot mutated: %v -> %v", beforeEvidence, got)
	}
	if before.Generation == after.Generation {
		t.Fatal("generation did not advance after undo")
	}
	// 冲正条目继承原业务时间，同刻按 ID 紧随原条目。
	wantPre := []int64{0, 60, 0, 60, 70}
	if got := after.PrefixEvidence(AxisBusiness); fmt.Sprint(got) != fmt.Sprint(wantPre) {
		t.Fatalf("after undo prefix = %v, want %v", got, wantPre)
	}
	// 冲正批是独立的已锁结算批。
	l.mu.Lock()
	_, ok := l.batches["undo-"+revID]
	l.mu.Unlock()
	if !ok {
		t.Fatalf("reversal batch undo-%s not recorded", revID)
	}
}

// 业务时间累计与提交时间累计必须区分。
func TestDualAxisDivergence(t *testing.T) {
	l := New()
	b := NewBatch("dual")
	// 业务时间与提交时间顺序相反。
	for _, e := range []Entry{
		entry("x", 1, 3, 80),
		entry("y", 2, 2, 80),
		entry("z", 3, 1, 80),
	} {
		if err := b.Add(e); err != nil {
			t.Fatal(err)
		}
	}
	mustCommit(t, l, b)

	s := l.Snapshot()
	if got := s.FirstExceed(AxisBusiness, 100); got != 2 {
		t.Fatalf("business FirstExceed(100) = %d, want 2", got)
	}
	if got := s.FirstExceed(AxisSubmit, 100); got != 2 {
		t.Fatalf("submit FirstExceed(100) = %d, want 2", got)
	}
	// 同位置不同条目：第 1 条业务序是 x，提交序是 z。
	be, se := s.Entries(AxisBusiness), s.Entries(AxisSubmit)
	if be[0].ID != "x" || se[0].ID != "z" {
		t.Fatalf("axis order not distinguished: business[0]=%s submit[0]=%s", be[0].ID, se[0].ID)
	}
	// 总量一致，分轴路径不同。
	if s.Cumulative(AxisBusiness, 3) != s.Cumulative(AxisSubmit, 3) {
		t.Fatal("totals on both axes must agree")
	}
}

// 未锁批次拒绝提交；撤销必须走冲正批而非改原条目。
func TestBatchLockingAndUndoRules(t *testing.T) {
	l := New()
	b := NewBatch("open")
	if err := b.Add(entry("e1", 1, 1, 10)); err != nil {
		t.Fatal(err)
	}
	if err := l.CommitBatch(b); err != ErrBatchNotLocked {
		t.Fatalf("commit unlocked batch: err = %v, want %v", err, ErrBatchNotLocked)
	}
	mustCommit(t, l, b)
	if err := b.Add(entry("e2", 2, 2, 5)); err == nil {
		t.Fatal("locked batch accepted new entry")
	}
	if err := l.CommitBatch(b); err == nil {
		t.Fatal("duplicate batch commit accepted")
	}
	if _, err := l.Undo("missing"); err == nil {
		t.Fatal("undo of missing entry accepted")
	}
	if _, err := l.Undo("e1"); err != nil {
		t.Fatalf("undo e1: %v", err)
	}
	if _, err := l.Undo("e1"); err == nil {
		t.Fatal("double undo accepted")
	}
	if _, err := l.Undo("e1:rev"); err == nil {
		t.Fatal("undo of reversal accepted")
	}
}

// 双索引原子发布：并发读者看到的快照两轴世代一致、长度一致、
// 前缀证据通过逐项扫描核对。
func TestAtomicPublication(t *testing.T) {
	l := New()
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				s := l.Snapshot()
				if len(s.byBusiness) != len(s.bySubmit) {
					t.Errorf("torn snapshot: %d vs %d entries", len(s.byBusiness), len(s.bySubmit))
					return
				}
				if len(s.preBusiness) != len(s.byBusiness)+1 || len(s.preSubmit) != len(s.bySubmit)+1 {
					t.Errorf("torn snapshot: prefix length mismatch")
					return
				}
				if ms := VerifySnapshot(s); len(ms) > 0 {
					t.Errorf("snapshot failed verification: %v", ms)
					return
				}
			}
		}()
	}
	for i := 0; i < 200; i++ {
		b := NewBatch(fmt.Sprintf("w%d", i))
		if err := b.Add(entry(fmt.Sprintf("w%d-e", i), i%24, (i*7)%24, int64(i-100))); err != nil {
			t.Fatal(err)
		}
		mustCommit(t, l, b)
	}
	close(stop)
	wg.Wait()
	if got := l.Snapshot().Len(); got != 200 {
		t.Fatalf("final length = %d, want 200", got)
	}
}

// 故障恢复：两轴全账重算，核对越界证据。
func TestRecoveryRecomputesBothAxes(t *testing.T) {
	l := New()
	b := NewBatch("hist")
	for _, e := range []Entry{
		entry("p", 3, 1, 120),
		entry("q", 1, 2, -50),
		entry("r", 2, 3, 90),
	} {
		if err := b.Add(e); err != nil {
			t.Fatal(err)
		}
	}
	mustCommit(t, l, b)
	if _, err := l.Undo("p"); err != nil {
		t.Fatal(err)
	}

	pre := l.Snapshot().FirstExceedEvidence(100)
	if ms := l.Recover(); len(ms) > 0 {
		t.Fatalf("recovery mismatches: %v", ms)
	}
	post := l.Snapshot()
	if got := post.FirstExceedEvidence(100); fmt.Sprint(got) != fmt.Sprint(pre) {
		t.Fatalf("exceed evidence changed across recovery: %v -> %v", pre, got)
	}
	// 恢复后快照仍须通过独立逐项扫描。
	if ms := VerifySnapshot(post); len(ms) > 0 {
		t.Fatalf("post-recovery verification: %v", ms)
	}
	// 业务轴：q(-50), r(90), p(120), p:rev(-120) → 0,-50,40,160,40
	want := []int64{0, -50, 40, 160, 40}
	if got := post.PrefixEvidence(AxisBusiness); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("business prefix after recovery = %v, want %v", got, want)
	}
}
