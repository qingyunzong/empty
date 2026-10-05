package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	problemPath := flag.String("problem", "", "问题 JSON 文件路径（车厢、车型、危险品规则）")
	showEnum := flag.Bool("enum", false, "输出全部切分与车型对照表")
	demo := flag.Bool("demo", false, "运行内置示例问题")
	flag.Parse()

	var p *Problem
	var err error
	switch {
	case *demo:
		p = demoProblem()
	case *problemPath != "":
		p, err = LoadProblem(*problemPath)
		if err != nil {
			fmt.Fprintln(os.Stderr, "错误:", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "用法: marshal -problem p.json [-enum] 或 marshal -demo")
		flag.PrintDefaults()
		os.Exit(2)
	}

	sol, err := Solve(p)
	if err != nil {
		fmt.Fprintln(os.Stderr, "错误:", err)
		os.Exit(1)
	}
	enum := Enumerate(p)
	fmt.Print(Certificate(p, sol, enum))
	if *showEnum {
		fmt.Println()
		fmt.Print(EnumTable(p, enum))
	}
}

// demoProblem 是内置示例：8 节车厢，含危险品相邻约束与三种车型。
func demoProblem() *Problem {
	return &Problem{
		Cars: []Car{
			{ID: "C1", Length: 12, Weight: 30},
			{ID: "C2", Length: 14, Weight: 45, Hazmat: "A"},
			{ID: "C3", Length: 10, Weight: 22},
			{ID: "C4", Length: 15, Weight: 50, Hazmat: "B"},
			{ID: "C5", Length: 11, Weight: 28},
			{ID: "C6", Length: 13, Weight: 40},
			{ID: "C7", Length: 12, Weight: 35, Hazmat: "A"},
			{ID: "C8", Length: 14, Weight: 44},
		},
		Incompatible: [][2]string{{"A", "B"}},
		Types: []TrainType{
			{Name: "轻载型", MaxCars: 3, MaxLength: 40, MaxWeight: 90, Cost: 100, AllowHazmat: false},
			{Name: "标准型", MaxCars: 4, MaxLength: 55, MaxWeight: 150, Cost: 160, AllowHazmat: true},
			{Name: "重载型", MaxCars: 6, MaxLength: 80, MaxWeight: 240, Cost: 260, AllowHazmat: true},
		},
	}
}
