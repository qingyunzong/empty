// logimport 是 logparse 包的命令行前端：从文件或标准输入读入日志，
// 按规则表切分记录并输出记录与诊断。读取按 -chunk-size 切块喂给解析器，
// 输出与切块大小无关。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"

	"logimport/logparse"
)

type event struct {
	Type  string      `json:"type"`
	Value interface{} `json:"value"`
	at    int64
}

func main() {
	maxLen := flag.Int("max-line-length", 0, "单行最大字节数（不含换行符），0 表示不限")
	chunkSize := flag.Int("chunk-size", 8192, "读取切块字节数，仅影响喂入方式，不影响结果")
	asJSON := flag.Bool("json", false, "以 JSON Lines 输出")
	flag.Parse()

	var events []event
	p := logparse.NewParser(
		logparse.Options{Rules: logparse.DefaultRules(), MaxLineLength: *maxLen},
		func(r logparse.Record) { events = append(events, event{Type: "record", Value: r, at: r.Start}) },
		func(d logparse.Diagnostic) { events = append(events, event{Type: "diagnostic", Value: d, at: d.Start}) },
	)

	if err := feed(p, flag.Args(), *chunkSize); err != nil {
		fmt.Fprintln(os.Stderr, "logimport:", err)
		os.Exit(1)
	}
	p.Close()

	sort.SliceStable(events, func(i, j int) bool { return events[i].at < events[j].at })
	for _, e := range events {
		if *asJSON {
			b, _ := json.Marshal(e.Value)
			fmt.Printf("{\"type\":%q,\"value\":%s}\n", e.Type, b)
			continue
		}
		switch v := e.Value.(type) {
		case logparse.Record:
			rule := v.Rule
			if rule == "" {
				rule = "plain"
			}
			fmt.Printf("record rule=%s span=%d:%d lines=%d\n", rule, v.Start, v.End, len(v.Lines))
			for _, l := range v.Lines {
				fmt.Printf("  | %s\n", l)
			}
		case logparse.Diagnostic:
			fmt.Printf("diag   kind=%s span=%d:%d %s\n", v.Kind, v.Start, v.End, v.Message)
		}
	}
}

func feed(p *logparse.Parser, files []string, chunk int) error {
	if chunk < 1 {
		chunk = 1
	}
	if len(files) == 0 {
		return pump(os.Stdin, p, chunk)
	}
	for _, name := range files {
		f, err := os.Open(name)
		if err != nil {
			return err
		}
		err = pump(f, p, chunk)
		f.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func pump(r io.Reader, p *logparse.Parser, chunk int) error {
	buf := make([]byte, chunk)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			p.Write(buf[:n])
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
