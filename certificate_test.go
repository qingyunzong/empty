package main

import (
	"strings"
	"testing"
)

func TestCertificate(t *testing.T) {
	p := demoProblem()
	sol, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	enum := Enumerate(p)
	cert := Certificate(p, sol, enum)
	for _, want := range []string{"编组证书", "最优方案", "车型对照", "穷举验证", "证书有效"} {
		if !strings.Contains(cert, want) {
			t.Errorf("证书缺少 %q", want)
		}
	}
	// 每种车型都应在某段对照中出现。
	for _, typ := range p.Types {
		if !strings.Contains(cert, typ.Name) {
			t.Errorf("证书未提及车型 %q", typ.Name)
		}
	}
}

func TestEnumTable(t *testing.T) {
	p := &Problem{
		Cars:  []Car{{ID: "a"}, {ID: "b"}},
		Types: []TrainType{{Name: "通", Cost: 5, AllowHazmat: true}},
	}
	enum := Enumerate(p)
	table := EnumTable(p, enum)
	if !strings.Contains(table, "共 2 种") {
		t.Error("对照表应列出 2 种切分")
	}
	if !strings.Contains(table, "[通]") {
		t.Error("对照表应标注车型")
	}
}

func TestLoadProblem(t *testing.T) {
	p, err := LoadProblem("examples/demo.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Cars) != 8 || len(p.Types) != 3 {
		t.Fatalf("示例加载异常: %d 车厢 %d 车型", len(p.Cars), len(p.Types))
	}
	sol, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	enum := Enumerate(p)
	if enum.Best == nil || sol.Cost != enum.Best.Cost || sol.Trains != enum.Best.Trains {
		t.Fatal("示例问题上 DP 与穷举不一致")
	}
}
