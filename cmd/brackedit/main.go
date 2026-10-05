// brackedit 是括号诊断库的命令行前端。
//
// 用法：
//
//	brackedit check <file>            全量扫描并输出诊断 JSON
//	brackedit edit [-verify] <file>   从 stdin 逐行读取编辑（JSON），
//	                                  增量应用并输出每步诊断 JSON
//
// 编辑输入格式（每行一个 JSON 对象）：
//
//	{"start": 10, "end": 12, "text": "("}
//
// start == end 表示插入，text 为空表示删除。-verify 会在每步编辑后
// 将增量结果与全量扫描核对，不一致则以非零状态退出。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"

	"bracketdiag"
)

type editOp struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Text  string `json:"text"`
}

func fatal(args ...any) {
	fmt.Fprintln(os.Stderr, args...)
	os.Exit(2)
}

func printDiag(d bracketdiag.Diagnostics) {
	out, err := json.Marshal(d)
	if err != nil {
		fatal("encode diagnostics:", err)
	}
	fmt.Println(string(out))
}

func main() {
	if len(os.Args) < 2 {
		fatal("usage: brackedit check <file> | brackedit edit [-verify] <file>")
	}
	switch os.Args[1] {
	case "check":
		if len(os.Args) != 3 {
			fatal("usage: brackedit check <file>")
		}
		data, err := os.ReadFile(os.Args[2])
		if err != nil {
			fatal(err)
		}
		printDiag(bracketdiag.Analyze(string(data)))
	case "edit":
		args := os.Args[2:]
		verify := false
		if len(args) > 0 && args[0] == "-verify" {
			verify = true
			args = args[1:]
		}
		if len(args) != 1 {
			fatal("usage: brackedit edit [-verify] <file>")
		}
		data, err := os.ReadFile(args[0])
		if err != nil {
			fatal(err)
		}
		doc := bracketdiag.NewDocument(string(data))
		printDiag(doc.Diagnostics())
		sc := bufio.NewScanner(os.Stdin)
		sc.Buffer(make([]byte, 0, 1<<20), 1<<20)
		step := 0
		for sc.Scan() {
			step++
			line := sc.Bytes()
			if len(line) == 0 {
				continue
			}
			var op editOp
			if err := json.Unmarshal(line, &op); err != nil {
				fatal("step", step, "bad edit:", err)
			}
			if err := doc.Edit(op.Start, op.End, op.Text); err != nil {
				fatal("step", step, err)
			}
			if verify {
				if err := doc.Verify(); err != nil {
					fatal("step", step, err)
				}
			}
			printDiag(doc.Diagnostics())
		}
		if err := sc.Err(); err != nil {
			fatal(err)
		}
	default:
		fatal("unknown command:", os.Args[1])
	}
}
