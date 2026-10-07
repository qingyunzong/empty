// Command scheduler solves a shift-scheduling problem given as JSON on
// stdin, or checks a proposed schedule with -check.
//
// Input:
//
//	{"num_people":4,"num_slots":5,"qualified":[[true,...],...],"cost":[[0,...],...]}
//
// Solve output:
//
//	{"feasible":true,"schedule":[[0,1],...],"cost":12}
//
// Check mode (-check schedule.json) prints "ok" or the violated
// constraint and exits non-zero.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"shiftsched/scheduler"
)

type problemJSON struct {
	NumPeople int      `json:"num_people"`
	NumSlots  int      `json:"num_slots"`
	Qualified [][]bool `json:"qualified"`
	Cost      [][]int  `json:"cost"`
}

type solveOutput struct {
	Feasible bool     `json:"feasible"`
	Schedule [][2]int `json:"schedule,omitempty"`
	Cost     int      `json:"cost,omitempty"`
}

func main() {
	checkPath := flag.String("check", "", "verify the schedule in this JSON file instead of solving")
	flag.Parse()

	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		fatal("reading stdin: %v", err)
	}
	var pj problemJSON
	if err := json.Unmarshal(data, &pj); err != nil {
		fatal("parsing problem JSON: %v", err)
	}
	problem := scheduler.Problem{
		NumPeople: pj.NumPeople,
		NumSlots:  pj.NumSlots,
		Qualified: pj.Qualified,
		Cost:      pj.Cost,
	}
	if err := problem.Validate(); err != nil {
		fatal("%v", err)
	}

	if *checkPath != "" {
		runCheck(problem, *checkPath)
		return
	}

	schedule, ok := scheduler.Solve(problem)
	out := solveOutput{Feasible: ok}
	if ok {
		out.Cost = scheduler.TotalCost(problem, schedule)
		for _, pr := range schedule {
			out.Schedule = append(out.Schedule, [2]int{pr[0], pr[1]})
		}
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		fatal("writing output: %v", err)
	}
	if !ok {
		os.Exit(1)
	}
}

func runCheck(problem scheduler.Problem, path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		fatal("reading schedule: %v", err)
	}
	var raw [][2]int
	if err := json.Unmarshal(data, &raw); err != nil {
		fatal("parsing schedule JSON: %v", err)
	}
	schedule := make(scheduler.Schedule, len(raw))
	for i, pr := range raw {
		schedule[i] = scheduler.Pair{pr[0], pr[1]}
	}
	if err := scheduler.Check(problem, schedule); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("ok (cost %d)\n", scheduler.TotalCost(problem, schedule))
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "scheduler: "+format+"\n", args...)
	os.Exit(2)
}
