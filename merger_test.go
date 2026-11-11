package q220

import (
	"errors"
	"strconv"
	"testing"
)

func TestMergeGraphsIsomorphic(t *testing.T) {
	base := []Triple{
		{blank("a1"), iri("p"), iri("u")},
		{blank("a1"), iri("q"), blank("a2")},
	}
	// 交换两个匿名标识并打乱三元组顺序，结构同构。
	incoming := []Triple{
		{blank("z2"), iri("q"), blank("z1")},
		{blank("z2"), iri("p"), iri("u")},
	}

	report, err := MergeGraphs(base, incoming)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Isomorphic || len(report.BlankMapping) != 2 {
		t.Fatalf("合并报告异常: %+v", report)
	}

	baseRes, err := Canonicalize(base)
	if err != nil {
		t.Fatal(err)
	}
	inRes, err := Canonicalize(incoming)
	if err != nil {
		t.Fatal(err)
	}
	baseNum := map[string]int{}
	for _, m := range baseRes.Mapping {
		if m.Source.Type == Blank {
			baseNum[m.Source.Value] = atoiForTest(t, m.Canonical.Value)
		}
	}
	inNum := map[string]int{}
	for _, m := range inRes.Mapping {
		if m.Source.Type == Blank {
			inNum[m.Source.Value] = atoiForTest(t, m.Canonical.Value)
		}
	}
	for _, bm := range report.BlankMapping {
		if inNum[bm.From] != baseNum[bm.To] {
			t.Fatalf("映射 %+v 不保持规范编号", bm)
		}
	}
}

func TestMergeGraphsNonIsomorphic(t *testing.T) {
	base := []Triple{
		{blank("a1"), iri("p"), iri("u")},
		{blank("a1"), iri("q"), blank("a2")},
	}
	// 谓语结构不同，不同构。
	incoming := []Triple{
		{blank("z1"), iri("p"), iri("u")},
		{blank("z1"), iri("r"), blank("z2")},
	}
	if _, err := MergeGraphs(base, incoming); !errors.Is(err, ErrNotIsomorphic) {
		t.Fatalf("got %v want ErrNotIsomorphic", err)
	}

	// 匿名节点数量不同也必须拒绝。
	fewer := []Triple{{blank("z1"), iri("p"), iri("u")}}
	if _, err := MergeGraphs(base, fewer); !errors.Is(err, ErrNotIsomorphic) {
		t.Fatalf("匿名数不同: got %v want ErrNotIsomorphic", err)
	}
}

func TestMergerLifecycle(t *testing.T) {
	mg := NewMerger()
	if mg.Base() != nil {
		t.Fatal("新合并器应为空")
	}

	first := []Triple{{blank("a1"), iri("p"), iri("u")}}
	report, err := mg.Merge(first)
	if err != nil || !report.Isomorphic {
		t.Fatalf("首张图应直接采用: %v %+v", err, report)
	}
	base := mg.Base()
	if base == nil {
		t.Fatal("首张图后 Base 不应为空")
	}

	iso := []Triple{{blank("renamed"), iri("p"), iri("u")}}
	report, err = mg.Merge(iso)
	if err != nil {
		t.Fatalf("同构图应合并成功: %v", err)
	}
	if len(report.BlankMapping) != 1 || report.BlankMapping[0].From != "renamed" ||
		report.BlankMapping[0].To != "a1" {
		t.Fatalf("匿名对应错误: %+v", report.BlankMapping)
	}
	if mg.Base() != base {
		t.Fatal("同构合并应保留原累积图")
	}

	diff := []Triple{{blank("x"), iri("other"), iri("u")}}
	if _, err := mg.Merge(diff); !errors.Is(err, ErrNotIsomorphic) {
		t.Fatalf("不同构图应被拒绝: %v", err)
	}
}

func TestMergeNoBlanks(t *testing.T) {
	g1 := []Triple{{iri("s"), iri("p"), iri("o")}}
	g2 := []Triple{{iri("s"), iri("p"), iri("o")}}
	report, err := MergeGraphs(g1, g2)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Isomorphic || len(report.BlankMapping) != 0 {
		t.Fatalf("无匿名节点同构图报告异常: %+v", report)
	}
}

func atoiForTest(t *testing.T, s string) int {
	t.Helper()
	v, err := strconv.Atoi(s)
	if err != nil {
		t.Fatal(err)
	}
	return v
}
