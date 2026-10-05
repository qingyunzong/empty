package frameindex

import (
	"reflect"
	"testing"
)

func mustAdd(t *testing.T, ix *Index, frames ...Frame) {
	t.Helper()
	for _, f := range frames {
		if err := ix.Add(f); err != nil {
			t.Fatalf("Add(%q): %v", f.ID, err)
		}
	}
}

// 典型 GOP：I0 P3 B1 B2（下标为显示时间），解码序与显示序不同。
// 解码时间 0..3 依次是 I0 P3 B1 B2；显示时间 0..3 依次是 I0 B1 B2 P3。
func gopIndex(t *testing.T) *Index {
	t.Helper()
	ix := NewIndex()
	mustAdd(t, ix,
		Frame{ID: "I0", DecodeTime: 0, DisplayTime: 0},
		Frame{ID: "P3", DecodeTime: 1, DisplayTime: 3, Refs: []string{"I0"}},
		Frame{ID: "B1", DecodeTime: 2, DisplayTime: 1, Refs: []string{"I0", "P3"}},
		Frame{ID: "B2", DecodeTime: 3, DisplayTime: 2, Refs: []string{"I0", "P3"}},
	)
	return ix
}

func TestSeekMinimalClosure(t *testing.T) {
	ix := gopIndex(t)
	// 再加一个与区间无关的帧，验证闭包的最小性。
	mustAdd(t, ix, Frame{ID: "X9", DecodeTime: 4, DisplayTime: 9})

	p := ix.SeekInterval(1, 2) // 只要 B1、B2
	wantTargets := []string{"B1", "B2"}
	if !reflect.DeepEqual(p.Targets, wantTargets) {
		t.Fatalf("targets = %v, want %v", p.Targets, wantTargets)
	}
	wantClosure := []string{"B1", "B2", "I0", "P3"}
	if !reflect.DeepEqual(p.Closure, wantClosure) {
		t.Fatalf("closure = %v, want %v", p.Closure, wantClosure)
	}
	for _, id := range p.Closure {
		if id == "X9" {
			t.Fatalf("closure contains unrelated frame X9")
		}
	}
	if len(p.Missing) != 0 || len(p.Cycles) != 0 {
		t.Fatalf("unexpected diagnostics: missing=%v cycles=%v", p.Missing, p.Cycles)
	}
	if err := ix.CheckAgainstModel(p); err != nil {
		t.Fatalf("model check: %v", err)
	}
}

func TestCertificateUsesDecodeOrderNotDisplayOrder(t *testing.T) {
	ix := gopIndex(t)
	p := ix.SeekInterval(0, 3) // 全部四帧
	cert, err := ix.Certify(p)
	if err != nil {
		t.Fatalf("Certify: %v", err)
	}
	// 解码序必须是 I0 P3 B1 B2；若错用显示时间会得到 I0 B1 B2 P3，
	// 且 B1 会在其参考 P3 之前解码，违反依赖。
	want := []string{"I0", "P3", "B1", "B2"}
	if !reflect.DeepEqual(cert.Order, want) {
		t.Fatalf("cert order = %v, want decode order %v", cert.Order, want)
	}
	// 模拟解码：按证书顺序解码，每帧的参考必须已解码。
	decoded := map[string]bool{}
	for _, id := range cert.Order {
		f, _ := ix.Get(id)
		for _, ref := range f.Refs {
			if !decoded[ref] {
				t.Fatalf("decoding %q: reference %q not yet decoded", id, ref)
			}
		}
		decoded[id] = true
	}
}

func TestSeekMissingReference(t *testing.T) {
	ix := NewIndex()
	mustAdd(t, ix,
		Frame{ID: "A", DecodeTime: 0, DisplayTime: 0, Refs: []string{"ghost"}},
		Frame{ID: "B", DecodeTime: 1, DisplayTime: 1, Refs: []string{"A"}},
	)
	p := ix.SeekInterval(1, 1)
	wantMissing := []MissingRef{{From: "A", RefID: "ghost"}}
	if !reflect.DeepEqual(p.Missing, wantMissing) {
		t.Fatalf("missing = %v, want %v", p.Missing, wantMissing)
	}
	// 缺失帧不进入闭包，其余依赖链完整。
	wantClosure := []string{"A", "B"}
	if !reflect.DeepEqual(p.Closure, wantClosure) {
		t.Fatalf("closure = %v, want %v", p.Closure, wantClosure)
	}
	if err := ix.CheckAgainstModel(p); err != nil {
		t.Fatalf("model check: %v", err)
	}
}

func TestSeekCycleReported(t *testing.T) {
	ix := NewIndex()
	mustAdd(t, ix,
		Frame{ID: "A", DecodeTime: 0, DisplayTime: 0, Refs: []string{"B"}},
		Frame{ID: "B", DecodeTime: 1, DisplayTime: 1, Refs: []string{"C"}},
		Frame{ID: "C", DecodeTime: 2, DisplayTime: 2, Refs: []string{"A"}},
	)
	p := ix.SeekInterval(0, 0)
	if len(p.Cycles) == 0 {
		t.Fatalf("expected cycle to be reported")
	}
	found := false
	for _, c := range p.Cycles {
		if c[0] == c[len(c)-1] && len(c) >= 2 {
			found = true
		}
	}
	if !found {
		t.Fatalf("malformed cycle report: %v", p.Cycles)
	}
	if err := ix.CheckAgainstModel(p); err != nil {
		t.Fatalf("model check: %v", err)
	}
	// 有环时不存在拓扑证书。
	if _, err := ix.Certify(p); err == nil {
		t.Fatalf("Certify should fail on cyclic plan")
	}
}

func TestSeekIntervalNormalizationAndEmpty(t *testing.T) {
	ix := gopIndex(t)
	p := ix.SeekInterval(3, 1) // 端点颠倒应被规整为 [1,3]
	if p.Start != 1 || p.End != 3 {
		t.Fatalf("interval not normalized: [%d,%d]", p.Start, p.End)
	}
	if len(p.Targets) != 3 {
		t.Fatalf("targets = %v, want 3 frames", p.Targets)
	}
	empty := ix.SeekInterval(100, 200)
	if len(empty.Targets) != 0 || len(empty.Closure) != 0 {
		t.Fatalf("empty interval should yield empty plan, got %+v", empty)
	}
	cert, err := ix.Certify(empty)
	if err != nil || len(cert.Order) != 0 {
		t.Fatalf("empty plan should certify to empty order, got %v err=%v", cert, err)
	}
}

func TestAddValidation(t *testing.T) {
	ix := NewIndex()
	if err := ix.Add(Frame{ID: "", DecodeTime: 0, DisplayTime: 0}); err == nil {
		t.Fatalf("empty ID should be rejected")
	}
	mustAdd(t, ix, Frame{ID: "A", DecodeTime: 0, DisplayTime: 0})
	if err := ix.Add(Frame{ID: "A", DecodeTime: 1, DisplayTime: 1}); err == nil {
		t.Fatalf("duplicate ID should be rejected")
	}
}
