package rescheck_test

import (
	"errors"
	"fmt"
	"math/rand"
	"sort"
	"testing"

	"rescheck"
)

// TestParentReclaimedOnlyAfterAllRefsReleased 验证父块在全部引用释放前不回收，
// 且回收沿树向上级联。
func TestParentReclaimedOnlyAfterAllRefsReleased(t *testing.T) {
	tr := rescheck.New()
	root, err := tr.Root("db")
	if err != nil {
		t.Fatal(err)
	}
	conn, err := root.Child("conn")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := conn.Child("tx")
	if err != nil {
		t.Fatal(err)
	}

	// 释放根与子句柄，但孙句柄仍存活：三个块都必须保留。
	if err := root.Release(); err != nil {
		t.Fatal(err)
	}
	if err := conn.Release(); err != nil {
		t.Fatal(err)
	}
	if got := tr.SlotsInUse(); got != 3 {
		t.Fatalf("父块提前回收：SlotsInUse = %d, 期望 3", got)
	}

	// 最后一个引用释放后，整条链级联回收。
	if err := tx.Release(); err != nil {
		t.Fatal(err)
	}
	if got := tr.SlotsInUse(); got != 0 {
		t.Fatalf("级联回收失败：SlotsInUse = %d, 期望 0", got)
	}
	if err := tr.Close(); err != nil {
		t.Fatal(err)
	}
}

// TestChildAfterCloseRejected 验证关闭后不允许再创建子句柄。
func TestChildAfterCloseRejected(t *testing.T) {
	tr := rescheck.New()
	h, err := tr.Root("db")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Release(); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Child("conn"); !errors.Is(err, rescheck.ErrClosed) {
		t.Fatalf("关闭后创建子句柄：err = %v, 期望 ErrClosed", err)
	}
	if err := tr.Close(); err != nil {
		t.Fatal(err)
	}
}

// TestDoubleRelease 验证重复释放被检测。
func TestDoubleRelease(t *testing.T) {
	tr := rescheck.New()
	h, err := tr.Root("db")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Release(); err != nil {
		t.Fatal(err)
	}
	if err := h.Release(); !errors.Is(err, rescheck.ErrDoubleRelease) {
		t.Fatalf("重复释放：err = %v, 期望 ErrDoubleRelease", err)
	}
}

// TestStaleHandleDetectedByGeneration 验证槽位复用后代际号递增，
// 旧代际句柄的任何操作都被拒绝。
func TestStaleHandleDetectedByGeneration(t *testing.T) {
	tr := rescheck.New()
	h1, err := tr.Root("a")
	if err != nil {
		t.Fatal(err)
	}
	if err := h1.Release(); err != nil {
		t.Fatal(err)
	}
	// LIFO 空闲表保证新根句柄复用同一槽位。
	h2, err := tr.Root("b")
	if err != nil {
		t.Fatal(err)
	}
	if h2.Generation() != h1.Generation()+1 {
		t.Fatalf("代际号未递增：旧 %d, 新 %d", h1.Generation(), h2.Generation())
	}
	if _, err := h1.Child("x"); !errors.Is(err, rescheck.ErrStale) {
		t.Fatalf("失效句柄创建子句柄：err = %v, 期望 ErrStale", err)
	}
	if err := h1.Release(); !errors.Is(err, rescheck.ErrStale) {
		t.Fatalf("失效句柄释放：err = %v, 期望 ErrStale", err)
	}
	if err := h2.Release(); err != nil {
		t.Fatal(err)
	}
	if err := tr.Close(); err != nil {
		t.Fatal(err)
	}
}

// TestLeakOwnerPath 验证泄漏报告输出带代际号的所有者路径。
func TestLeakOwnerPath(t *testing.T) {
	tr := rescheck.New()
	db, err := tr.Root("db")
	if err != nil {
		t.Fatal(err)
	}
	conn, err := db.Child("conn")
	if err != nil {
		t.Fatal(err)
	}
	// 释放父句柄，子句柄泄漏：路径仍完整保留。
	if err := db.Release(); err != nil {
		t.Fatal(err)
	}

	leaks := tr.Leaks()
	if len(leaks) != 1 || leaks[0] != "db#1/conn#1" {
		t.Fatalf("泄漏路径 = %v, 期望 [db#1/conn#1]", leaks)
	}

	err = tr.Close()
	var le *rescheck.LeakError
	if !errors.As(err, &le) {
		t.Fatalf("Close err = %v, 期望 *LeakError", err)
	}
	if len(le.Paths) != 1 || le.Paths[0] != "db#1/conn#1" {
		t.Fatalf("LeakError.Paths = %v, 期望 [db#1/conn#1]", le.Paths)
	}

	// 清理：泄漏句柄释放后 Close 不再报错。
	if err := conn.Release(); err != nil {
		t.Fatal(err)
	}
	if leaks := tr.Leaks(); len(leaks) != 0 {
		t.Fatalf("清理后仍有泄漏: %v", leaks)
	}
}

// modelNode 是合法随机图测试中的参考模型节点。
type modelNode struct {
	h    *rescheck.Handle
	open bool
}

// TestRandomLegalGraph 随机生成合法的句柄操作图（创建根/派生子/释放），
// 每步与参考模型对照泄漏集合，结尾全部释放后要求零泄漏、槽位全回收。
func TestRandomLegalGraph(t *testing.T) {
	rng := rand.New(rand.NewSource(20261008))
	tr := rescheck.New()
	var open []*modelNode

	for i := 0; i < 3000; i++ {
		switch {
		case len(open) == 0 || rng.Intn(100) < 35:
			h, err := tr.Root(fmt.Sprintf("r%d", i))
			if err != nil {
				t.Fatalf("第 %d 步创建根句柄失败: %v", i, err)
			}
			open = append(open, &modelNode{h: h, open: true})
		default:
			n := open[rng.Intn(len(open))]
			if rng.Intn(100) < 50 {
				c, err := n.h.Child(fmt.Sprintf("c%d", i))
				if err != nil {
					t.Fatalf("第 %d 步创建子句柄失败: %v", i, err)
				}
				open = append(open, &modelNode{h: c, open: true})
			} else {
				if err := n.h.Release(); err != nil {
					t.Fatalf("第 %d 步释放失败: %v", i, err)
				}
				n.open = false
				open = removeNode(open, n)
			}
		}

		if i%37 == 0 {
			assertLeaksMatch(t, tr, open, i)
		}
	}
	assertLeaksMatch(t, tr, open, -1)

	for _, n := range open {
		if err := n.h.Release(); err != nil {
			t.Fatalf("收尾释放失败: %v", err)
		}
	}
	if leaks := tr.Leaks(); len(leaks) != 0 {
		t.Fatalf("全部释放后仍有泄漏: %v", leaks)
	}
	if got := tr.SlotsInUse(); got != 0 {
		t.Fatalf("全部释放后 SlotsInUse = %d, 期望 0", got)
	}
	if err := tr.Close(); err != nil {
		t.Fatalf("无泄漏时 Close 应成功: %v", err)
	}
}

func removeNode(s []*modelNode, n *modelNode) []*modelNode {
	for i, m := range s {
		if m == n {
			return append(s[:i], s[i+1:]...)
		}
	}
	return s
}

func assertLeaksMatch(t *testing.T, tr *rescheck.Tracker, open []*modelNode, step int) {
	t.Helper()
	want := make([]string, 0, len(open))
	for _, n := range open {
		want = append(want, n.h.Path())
	}
	sort.Strings(want)
	got := tr.Leaks()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("第 %d 步泄漏集合不一致:\n got: %v\nwant: %v", step, got, want)
	}
}

// buildLegalGraph 执行一段合法随机操作，返回跟踪器与当前存活的句柄。
func buildLegalGraph(t *testing.T, rng *rand.Rand, steps int) (*rescheck.Tracker, []*rescheck.Handle) {
	t.Helper()
	tr := rescheck.New()
	var alive []*rescheck.Handle
	for i := 0; i < steps; i++ {
		switch {
		case len(alive) == 0 || rng.Intn(100) < 40:
			h, err := tr.Root(fmt.Sprintf("r%d", i))
			if err != nil {
				t.Fatal(err)
			}
			alive = append(alive, h)
		default:
			j := rng.Intn(len(alive))
			if rng.Intn(100) < 50 {
				c, err := alive[j].Child(fmt.Sprintf("c%d", i))
				if err != nil {
					t.Fatal(err)
				}
				alive = append(alive, c)
			} else {
				if err := alive[j].Release(); err != nil {
					t.Fatal(err)
				}
				alive = append(alive[:j], alive[j+1:]...)
			}
		}
	}
	return tr, alive
}

func releaseAll(t *testing.T, handles []*rescheck.Handle) {
	t.Helper()
	for _, h := range handles {
		if err := h.Release(); err != nil {
			t.Fatalf("清理释放失败: %v", err)
		}
	}
}

// TestSingleErrorInjection 在合法操作序列上注入恰好一个错误，
// 验证库能逐类检测：重复释放、关闭后派生、失效句柄、泄漏。
func TestSingleErrorInjection(t *testing.T) {
	t.Run("DoubleRelease", func(t *testing.T) {
		rng := rand.New(rand.NewSource(1))
		tr, alive := buildLegalGraph(t, rng, 200)
		victim := alive[rng.Intn(len(alive))]
		if err := victim.Release(); err != nil {
			t.Fatal(err)
		}
		if err := victim.Release(); !errors.Is(err, rescheck.ErrDoubleRelease) {
			t.Fatalf("注入重复释放未被检测: %v", err)
		}
		// 清理（victim 已从存活集合移除）。
		rest := make([]*rescheck.Handle, 0, len(alive))
		for _, h := range alive {
			if h != victim {
				rest = append(rest, h)
			}
		}
		releaseAll(t, rest)
		if err := tr.Close(); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("ChildAfterClose", func(t *testing.T) {
		rng := rand.New(rand.NewSource(2))
		tr, alive := buildLegalGraph(t, rng, 200)
		victim := alive[rng.Intn(len(alive))]
		if err := victim.Release(); err != nil {
			t.Fatal(err)
		}
		if _, err := victim.Child("injected"); !errors.Is(err, rescheck.ErrClosed) {
			t.Fatalf("注入关闭后派生未被检测: %v", err)
		}
		rest := make([]*rescheck.Handle, 0, len(alive))
		for _, h := range alive {
			if h != victim {
				rest = append(rest, h)
			}
		}
		releaseAll(t, rest)
		if err := tr.Close(); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("StaleHandle", func(t *testing.T) {
		rng := rand.New(rand.NewSource(3))
		tr, alive := buildLegalGraph(t, rng, 200)
		// 释放一个无子句柄的根/叶句柄，再创建新句柄复用其槽位。
		stale, err := tr.Root("victim")
		if err != nil {
			t.Fatal(err)
		}
		if err := stale.Release(); err != nil {
			t.Fatal(err)
		}
		fresh, err := tr.Root("fresh")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := stale.Child("injected"); !errors.Is(err, rescheck.ErrStale) {
			t.Fatalf("注入失效句柄未被检测: %v", err)
		}
		if err := fresh.Release(); err != nil {
			t.Fatal(err)
		}
		releaseAll(t, alive)
		if err := tr.Close(); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("ForgottenRelease", func(t *testing.T) {
		rng := rand.New(rand.NewSource(4))
		tr, alive := buildLegalGraph(t, rng, 200)
		leaked, err := alive[rng.Intn(len(alive))].Child("leaked")
		if err != nil {
			t.Fatal(err)
		}
		releaseAll(t, alive)
		// 恰好遗漏一个释放：Close 必须报告该所有者路径。
		err = tr.Close()
		var le *rescheck.LeakError
		if !errors.As(err, &le) {
			t.Fatalf("注入泄漏未被检测: %v", err)
		}
		if len(le.Paths) != 1 || le.Paths[0] != leaked.Path() {
			t.Fatalf("泄漏路径 = %v, 期望 [%s]", le.Paths, leaked.Path())
		}
	})

	// 随机化注入：合法随机脚本 + 随机选择一类单错注入，必须被检测。
	t.Run("RandomScriptSingleFault", func(t *testing.T) {
		for seed := int64(10); seed < 30; seed++ {
			rng := rand.New(rand.NewSource(seed))
			tr, alive := buildLegalGraph(t, rng, 100+rng.Intn(300))
			switch rng.Intn(4) {
			case 0: // 重复释放
				j := rng.Intn(len(alive))
				v := alive[j]
				alive = append(alive[:j], alive[j+1:]...)
				if err := v.Release(); err != nil {
					t.Fatal(err)
				}
				if err := v.Release(); !errors.Is(err, rescheck.ErrDoubleRelease) {
					t.Fatalf("seed %d: 重复释放未检测: %v", seed, err)
				}
			case 1: // 关闭后派生
				j := rng.Intn(len(alive))
				v := alive[j]
				alive = append(alive[:j], alive[j+1:]...)
				if err := v.Release(); err != nil {
					t.Fatal(err)
				}
				if _, err := v.Child("x"); !errors.Is(err, rescheck.ErrClosed) {
					t.Fatalf("seed %d: 关闭后派生未检测: %v", seed, err)
				}
			case 2: // 失效句柄
				v, err := tr.Root("v")
				if err != nil {
					t.Fatal(err)
				}
				if err := v.Release(); err != nil {
					t.Fatal(err)
				}
				f, err := tr.Root("f")
				if err != nil {
					t.Fatal(err)
				}
				if err := v.Release(); !errors.Is(err, rescheck.ErrStale) {
					t.Fatalf("seed %d: 失效句柄未检测: %v", seed, err)
				}
				if err := f.Release(); err != nil {
					t.Fatal(err)
				}
			case 3: // 泄漏
				v := alive[rng.Intn(len(alive))]
				leaked, err := v.Child("leaked")
				if err != nil {
					t.Fatal(err)
				}
				releaseAll(t, alive)
				alive = nil
				var le *rescheck.LeakError
				if err := tr.Close(); !errors.As(err, &le) {
					t.Fatalf("seed %d: 泄漏未检测: %v", seed, err)
				}
				if len(le.Paths) != 1 || le.Paths[0] != leaked.Path() {
					t.Fatalf("seed %d: 泄漏路径 = %v, 期望 [%s]", seed, le.Paths, leaked.Path())
				}
			}
			releaseAll(t, alive)
		}
	})
}
