package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
)

// 从 stdin 或 -f 指定的文件读取 JSON 实例，输出最优解 JSON：
// {"minLoss":..., "starts":[...], "occupancy":[...]}。
func main() {
	var file string
	flag.StringVar(&file, "f", "", "input JSON file (default: stdin)")
	flag.Parse()

	var (
		data []byte
		err  error
	)
	if file == "" {
		data, err = io.ReadAll(os.Stdin)
	} else {
		data, err = os.ReadFile(file)
	}
	if err != nil {
		fatal(err)
	}
	var in Instance
	if err := json.Unmarshal(data, &in); err != nil {
		fatal(fmt.Errorf("parse input: %w", err))
	}
	res, err := Solve(in)
	if err != nil {
		fatal(err)
	}
	out, err := json.MarshalIndent(res, "", "  ")
	if err != nil {
		fatal(err)
	}
	fmt.Println(string(out))
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
