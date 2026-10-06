// libreadcheck 校验库读日志：按票据代际重建状态，报告首错及完整因果链。
//
// 用法: libreadcheck [日志文件]（缺省读标准输入）。
// 退出码: 0 合法；1 发现违规；2 解析失败。
package main

import (
	"fmt"
	"io"
	"os"

	"libread/checker"
)

func main() {
	var r io.Reader = os.Stdin
	if len(os.Args) > 1 {
		f, err := os.Open(os.Args[1])
		if err != nil {
			fmt.Fprintln(os.Stderr, "打开日志失败:", err)
			os.Exit(2)
		}
		defer f.Close()
		r = f
	}
	events, err := checker.Parse(r)
	if err != nil {
		fmt.Fprintln(os.Stderr, "解析失败:", err)
		os.Exit(2)
	}
	if v := checker.CheckEvents(events); v != nil {
		fmt.Fprintf(os.Stderr, "首错: %v\n", v)
		os.Exit(1)
	}
	fmt.Printf("OK: %d 条事件，状态重建一致，在途授予总额始终未超当刻上限\n", len(events))
}
