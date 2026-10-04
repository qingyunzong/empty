package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// 用法:
//
//	mvsg 'W1(x) W2(x) R3(x2) R1(y3) W3(y)'
//	echo 'W1(x) R2(x1)' | mvsg
//
// 退出码: 0 = 可串行化, 1 = 不可串行化, 2 = 输入错误。
func main() {
	var input string
	if len(os.Args) > 1 {
		input = strings.Join(os.Args[1:], " ")
	} else {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			fmt.Fprintln(os.Stderr, "读取标准输入失败:", err)
			os.Exit(2)
		}
		input = string(data)
	}
	h, err := ParseHistory(input)
	if err != nil {
		fmt.Fprintln(os.Stderr, "输入错误:", err)
		os.Exit(2)
	}
	rep := Analyze(h)
	fmt.Print(rep.String())
	if !rep.Acyclic {
		os.Exit(1)
	}
}
