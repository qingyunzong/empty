package rescheck

import (
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

// TestParentReclaimedOnlyAfterAllRefs 验证父块在自身引用与全部
// 子孙引用释放后才被回收。
func TestParentReclaimedOnlyAfterAllRefs(t *testing.T) {
	tr := NewTracker()
	root, err := tr.Open("root")
	if err != nil {
		t.Fatal(err)
	}
	child, err := tr.Child(root, "child")
	if err != nil {
		t.Fatal(err)
	}
	grand, err := tr.Child(child, "grand")
	if err != nil {
		t.Fatal(err)
	}

	// 关闭父与祖父，块因子孙存活不得回收。
	if err := tr.Close(root); err != nil {
		t.Fatal(err)
	}
	if err := tr.Close(child); err != nil {
		t.Fatal(err)
	}
	if got := tr.LiveBlocks(); got != 3 {
		t.Fatalf("LiveBlocks = %d, want 3 (父块等待子孙释放)", got)
	}

	// 释放最后一个子孙，整链级联回收。
	if err := tr.Close(grand); err != nil {
		t.Fatal(err)
	}
	if got := tr.LiveBlocks(); got != 0 {
		t.Fatalf("LiveBlocks = %d, want 0 (全部引用释放后级联回收)", got)
	}
	if err := tr.CloseTracker(); err != nil {
		t.Fatalf("无泄漏时应关闭成功: %v", err)
	}
}

// TestNoChildAfterClose 验证句柄关闭后不允许再创建子句柄。
func TestNoChildAfterClose(t *testing.T) {
	tr := NewTracker()
	h, _ := tr.Open("db")
	if err := tr.Close(h); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.Child(h, "conn"); !errors.Is(err, ErrHandleClosed) {
		t.Fatalf("err = %v, want ErrHandleClosed", err)
	}
}

// TestDoubleClose 验证重复关闭报错。
func TestDoubleClose(t *testing.T) {
	tr := NewTracker()
	h, _ := tr.Open("db")
	if err := tr.Close(h); err != nil {
		t.Fatal(err)
	}
	if err := tr.Close(h); !errors.Is(err, ErrHandleClosed) {
		t.Fatalf("err = %v, want ErrHandleClosed", err)
	}
}

// TestGenerationDistinguishesReuse 验证编号复用后旧代际句柄失效。
func TestGenerationDistinguishesReuse(t *testing.T) {
	tr := NewTracker()
	old, _ := tr.Open("first")
	if err := tr.Close(old); err != nil {
		t.Fatal(err)
	}
	reused, err := tr.Open("second")
	if err != nil {
		t.Fatal(err)
	}
	if reused.ID != old.ID {
		t.Fatalf("reused.ID = %d, want 复用编号 %d", reused.ID, old.ID)
	}
	if reused.Gen == old.Gen {
		t.Fatalf("复用编号必须递增代际, got gen %d", reused.Gen)
	}
	// 旧代际句柄的任何操作都必须被拒绝。
	if _, err := tr.Child(old, "sneaky"); !errors.Is(err, ErrStaleHandle) {
		t.Fatalf("Child on stale handle: err = %v, want ErrStaleHandle", err)
	}
	if err := tr.Close(old); !errors.Is(err, ErrStaleHandle) {
		t.Fatalf("Close on stale handle: err = %v, want ErrStaleHandle", err)
	}
	// 新代际句柄正常工作。
	if err := tr.Close(reused); err != nil {
		t.Fatal(err)
	}
}

// TestLeakOwnerPaths 验证泄漏报告输出完整的所有者路径。
func TestLeakOwnerPaths(t *testing.T) {
	tr := NewTracker()
	db, _ := tr.Open("db")
	conn, _ := tr.Child(db, "conn")
	tx, _ := tr.Child(conn, "tx")
	if _, err := tr.Open("tmp"); err != nil {
		t.Fatal(err)
	}

	// 释放 tx 自身引用但保留 conn 与 tmp：泄漏应包含 db、conn、tmp。
	if err := tr.Close(tx); err != nil {
		t.Fatal(err)
	}
	leaks := tr.Leaks()
	joined := strings.Join(leaks, "\n")
	for _, want := range []string{"db(", "db(0#1)/conn(1#1)", "tmp("} {
		if !strings.Contains(joined, want) {
			t.Errorf("泄漏路径缺少 %q, 实际:\n%s", want, joined)
		}
	}
	// tx 已释放，不应出现在泄漏中。
	if strings.Contains(joined, "tx(") {
		t.Errorf("已释放句柄不应出现在泄漏路径中:\n%s", joined)
	}

	err := tr.CloseTracker()
	if err == nil || !strings.Contains(err.Error(), "conn") {
		t.Fatalf("CloseTracker 应报告泄漏, got %v", err)
	}
	// 追踪器关闭后不允许再创建根句柄。
	if _, err := tr.Open("late"); !errors.Is(err, ErrTrackerClosed) {
		t.Fatalf("err = %v, want ErrTrackerClosed", err)
	}
}

// model 是测试侧的参考实现，用于与 Tracker 对拍。
type model struct {
	open     map[Handle]bool   // 自身引用仍持有的句柄
	parent   map[Handle]Handle // 句柄的父
	children map[Handle][]Handle
	roots    []Handle
}

func newModel() *model {
	return &model{
		open:     make(map[Handle]bool),
		parent:   make(map[Handle]Handle),
		children: make(map[Handle][]Handle),
	}
}

func (m *model) liveHandles() []Handle {
	var out []Handle
	for h, ok := range m.open {
		if ok {
			out = append(out, h)
		}
	}
	return out
}

// liveBlocks 计算模型中应存活的块数：块存活当且仅当自身引用
// 未释放或存在存活子孙。
func (m *model) liveBlocks() int {
	alive := make(map[Handle]bool)
	var mark func(h Handle) bool
	mark = func(h Handle) bool {
		a := m.open[h]
		for _, c := range m.children[h] {
			if mark(c) {
				a = true
			}
		}
		alive[h] = a
		return a
	}
	for _, r := range m.roots {
		mark(r)
	}
	count := 0
	for _, a := range alive {
		if a {
			count++
		}
	}
	return count
}

// runRandomLegal 在 tr 上执行 steps 步随机合法操作并同步维护模型。
func runRandomLegal(t *testing.T, rng *rand.Rand, tr *Tracker, m *model, steps int) {
	t.Helper()
	for i := 0; i < steps; i++ {
		live := m.liveHandles()
		switch {
		case len(live) == 0 || rng.Intn(100) < 35:
			h, err := tr.Open(fmt.Sprintf("r%d", i))
			if err != nil {
				t.Fatalf("step %d: Open: %v", i, err)
			}
			m.open[h] = true
			m.roots = append(m.roots, h)
		case rng.Intn(100) < 60:
			p := live[rng.Intn(len(live))]
			h, err := tr.Child(p, fmt.Sprintf("c%d", i))
			if err != nil {
				t.Fatalf("step %d: Child(%s): %v", i, p, err)
			}
			m.open[h] = true
			m.parent[h] = p
			m.children[p] = append(m.children[p], h)
		default:
			h := live[rng.Intn(len(live))]
			if err := tr.Close(h); err != nil {
				t.Fatalf("step %d: Close(%s): %v", i, h, err)
			}
			m.open[h] = false
		}
		if got, want := tr.LiveBlocks(), m.liveBlocks(); got != want {
			t.Fatalf("step %d: LiveBlocks = %d, 模型期望 %d", i, got, want)
		}
	}
}

// TestRandomLegalGraph 随机生成合法句柄图，与参考模型对拍。
func TestRandomLegalGraph(t *testing.T) {
	for seed := int64(0); seed < 20; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			tr := NewTracker()
			m := newModel()
			runRandomLegal(t, rng, tr, m, 400)

			// 泄漏集合必须与模型中未释放句柄一致。
			leaks := tr.Leaks()
			wantOpen := 0
			for _, ok := range m.open {
				if ok {
					wantOpen++
				}
			}
			if len(leaks) != wantOpen {
				t.Fatalf("泄漏数 = %d, 模型期望 %d\n%s", len(leaks), wantOpen, strings.Join(leaks, "\n"))
			}
		})
	}
}

// TestSingleErrorInjection 在合法随机序列后注入单个非法操作，
// 验证追踪器精确报错且状态不被破坏（后续合法操作与模型仍一致）。
func TestSingleErrorInjection(t *testing.T) {
	for seed := int64(100); seed < 110; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			tr := NewTracker()
			m := newModel()
			runRandomLegal(t, rng, tr, m, 200)

			live := m.liveHandles()
			if len(live) == 0 {
				t.Skip("随机序列未留下存活句柄")
			}
			victim := live[rng.Intn(len(live))]

			// 为 victim 保留一个存活子块，确保关闭 victim 后其块
			// 不被回收，从而双关/关后建子句柄能被精确识别。
			keeper, err := tr.Child(victim, "keeper")
			if err != nil {
				t.Fatalf("创建 keeper 子句柄失败: %v", err)
			}
			m.open[keeper] = true
			m.parent[keeper] = victim
			m.children[victim] = append(m.children[victim], keeper)

			// 注入单错：关闭 victim 两次中的第二次 / 在已关闭句柄上
			// 建子句柄 / 使用伪造代际，三者随机取一。
			var injectErr error
			switch rng.Intn(3) {
			case 0:
				if err := tr.Close(victim); err != nil {
					t.Fatalf("首次合法 Close 失败: %v", err)
				}
				m.open[victim] = false
				injectErr = tr.Close(victim) // 重复关闭
				if !errors.Is(injectErr, ErrHandleClosed) {
					t.Fatalf("注入重复关闭: err = %v, want ErrHandleClosed", injectErr)
				}
			case 1:
				if err := tr.Close(victim); err != nil {
					t.Fatalf("首次合法 Close 失败: %v", err)
				}
				m.open[victim] = false
				_, injectErr = tr.Child(victim, "illegal") // 关闭后建子句柄
				if !errors.Is(injectErr, ErrHandleClosed) {
					t.Fatalf("注入关闭后建子句柄: err = %v, want ErrHandleClosed", injectErr)
				}
			case 2:
				forged := Handle{ID: victim.ID, Gen: victim.Gen + 100} // 伪造代际
				injectErr = tr.Close(forged)
				if !errors.Is(injectErr, ErrStaleHandle) {
					t.Fatalf("注入伪造代际: err = %v, want ErrStaleHandle", injectErr)
				}
			}

			// 单错注入后追踪器状态必须仍然自洽：继续合法操作并对拍。
			runRandomLegal(t, rng, tr, m, 200)
			if got, want := tr.LiveBlocks(), m.liveBlocks(); got != want {
				t.Fatalf("注入后 LiveBlocks = %d, 模型期望 %d", got, want)
			}
		})
	}
}
