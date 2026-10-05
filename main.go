package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	jsonOut := flag.Bool("json", false, "以 JSON 输出结果")
	useBrute := flag.Bool("brute", false, "使用暴力枚举求解（仅适合小规模验证）")
	flag.Parse()

	var r io.Reader = os.Stdin
	if flag.NArg() > 0 {
		f, err := os.Open(flag.Arg(0))
		if err != nil {
			fmt.Fprintln(os.Stderr, "打开输入文件失败:", err)
			os.Exit(1)
		}
		defer f.Close()
		r = f
	}
	var p Problem
	if err := json.NewDecoder(r).Decode(&p); err != nil {
		fmt.Fprintln(os.Stderr, "解析输入 JSON 失败:", err)
		os.Exit(1)
	}
	_, order, err := p.validate()
	if err != nil {
		fmt.Fprintln(os.Stderr, "输入非法:", err)
		os.Exit(1)
	}

	var sol Solution
	if *useBrute {
		sol = BruteForce(&p, order)
	} else {
		sol = Solve(&p, order)
	}
	lines := Explain(&p, sol)

	if *jsonOut {
		type taskOut struct {
			ID        string  `json:"id"`
			Abandoned bool    `json:"abandoned"`
			Window    *Window `json:"window,omitempty"`
			Explain   string  `json:"explain"`
		}
		out := struct {
			TotalCost int       `json:"total_cost"`
			Tasks     []taskOut `json:"tasks"`
		}{TotalCost: sol.Cost}
		for i, t := range p.Tasks {
			to := taskOut{ID: t.ID, Abandoned: sol.Assign[i] < 0, Explain: lines[i]}
			if !to.Abandoned {
				w := t.Windows[sol.Assign[i]]
				to.Window = &w
			}
			out.Tasks = append(out.Tasks, to)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		enc.Encode(out)
		return
	}

	fmt.Printf("总费用: %d\n", sol.Cost)
	for _, l := range lines {
		fmt.Println(l)
	}
}
