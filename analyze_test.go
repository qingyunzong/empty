package main

import (
	"strings"
	"testing"
)

func TestAnalyzeCyclicReport(t *testing.T) {
	h := mustParse(t, "W1(x) W3(y) R1(y3) R2(x1) W3(x)")
	rep := Analyze(h)
	if rep.Acyclic {
		t.Fatal("expected cyclic")
	}
	out := rep.String()
	for _, want := range []string{
		"不可串行化",
		"T1 -WR(x)-> T2",
		"T2 -RW(x)-> T3",
		"T3 -WR(y)-> T1",
		"具体冲突边链",
		"有效串行序 0 个",
		"与图判定一致",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("report missing %q\n%s", want, out)
		}
	}
}

func TestAnalyzeAcyclicReport(t *testing.T) {
	h := mustParse(t, "W2(x) W1(y) R3(y1) R3(x2)")
	rep := Analyze(h)
	if !rep.Acyclic || !rep.ReplayOK {
		t.Fatalf("acyclic=%v replayOK=%v", rep.Acyclic, rep.ReplayOK)
	}
	out := rep.String()
	for _, want := range []string{
		"可串行化",
		"第 1 轮: 候选 {T1, T2} -> 选 T1",
		"最终串行序: T1 -> T2 -> T3",
		"重放验证: 通过 (2/2 读取版本一致)",
		"与图判定一致",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("report missing %q\n%s", want, out)
		}
	}
}

func TestAnalyzeLargeSkipsEnumeration(t *testing.T) {
	h := mustParse(t, "W1(a) W2(b) W3(c) W4(d) W5(e) W6(f) W7(g) W8(h) W9(i)")
	rep := Analyze(h)
	if rep.EnumDone {
		t.Fatal("enumeration should be skipped for 9 transactions")
	}
	if !strings.Contains(rep.String(), "跳过") {
		t.Fatal("report should note enumeration skipped")
	}
}
