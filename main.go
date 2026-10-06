package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type output struct {
	OK        bool     `json:"ok"`
	Cost      int      `json:"cost"`
	Starts    []int    `json:"starts"`
	Intervals [][2]int `json:"intervals"` // 半开区间 [start, end)
	Occupancy []int    `json:"occupancy"` // 占用曲线：每时刻停机台数
}

func main() {
	var p Problem
	if err := json.NewDecoder(os.Stdin).Decode(&p); err != nil {
		fmt.Fprintln(os.Stderr, "invalid input:", err)
		os.Exit(1)
	}
	ok, cost, starts, occ := Solve(p)
	out := output{OK: ok, Cost: cost, Starts: starts, Occupancy: occ}
	if ok {
		for i, s := range starts {
			out.Intervals = append(out.Intervals, [2]int{s, s + p.Devices[i].Dur})
		}
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if !ok {
		os.Exit(2)
	}
}
