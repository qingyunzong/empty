package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
)

func readInput(path string) ([]byte, error) {
	if path == "" || path == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(path)
}

func main() {
	input := flag.String("input", "", "问题 JSON 文件路径（缺省或 - 表示标准输入）")
	verify := flag.Bool("verify", false, "对小数据做完整枚举，验证分支定界结果最优")
	flag.Parse()

	data, err := readInput(*input)
	if err != nil {
		fmt.Fprintln(os.Stderr, "读取输入失败:", err)
		os.Exit(1)
	}
	var prob Problem
	if err := json.Unmarshal(data, &prob); err != nil {
		fmt.Fprintln(os.Stderr, "解析 JSON 失败:", err)
		os.Exit(1)
	}

	sol, err := Solve(&prob)
	if err != nil {
		fmt.Fprintln(os.Stderr, "求解失败:", err)
		os.Exit(1)
	}

	fmt.Printf("总费用（安排费用 + 放弃罚费）：%d\n", sol.Cost)
	fmt.Println("各项安排与冲突解释：")
	for _, line := range Explain(&prob, sol) {
		fmt.Println(line)
	}

	if *verify {
		bf, err := BruteForce(&prob)
		if err != nil {
			fmt.Fprintln(os.Stderr, "枚举验证失败:", err)
			os.Exit(1)
		}
		if bf.Cost != sol.Cost {
			fmt.Fprintf(os.Stderr, "验证不通过：分支定界 %d，枚举 %d\n", sol.Cost, bf.Cost)
			os.Exit(1)
		}
		fmt.Printf("枚举验证通过：完整枚举最优费用同为 %d。\n", bf.Cost)
	}
}
