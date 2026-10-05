// cutcli plans how to cut integer-length stock bars into demanded pieces.
//
//	cutcli solve      -job job.json [-state state.json]
//	cutcli bounds     -job job.json [-state state.json]
//	cutcli inventory  -state state.json
//
// solve prints the optimal cutting plan as JSON and, when -state is
// given, folds reusable leftovers back into the inventory so later
// orders (e.g. demand corrections) reuse them with stable IDs.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"cutcli/cut"
)

func usage() {
	fmt.Fprintln(os.Stderr, "usage: cutcli <solve|bounds|inventory> -job job.json [-state state.json]")
	os.Exit(2)
}

func readJob(path string) (cut.Job, error) {
	var data []byte
	var err error
	if path == "-" {
		data, err = readStdin()
	} else {
		data, err = os.ReadFile(path)
	}
	if err != nil {
		return cut.Job{}, err
	}
	var job cut.Job
	if err := json.Unmarshal(data, &job); err != nil {
		return cut.Job{}, err
	}
	return job, nil
}

func readStdin() ([]byte, error) {
	return io.ReadAll(os.Stdin)
}

func writeJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	enc.Encode(v)
}

func argValue(args []string, name string) string {
	for i, a := range args {
		if a == name && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	cmd := os.Args[1]
	args := os.Args[2:]
	jobPath := argValue(args, "-job")
	statePath := argValue(args, "-state")

	switch cmd {
	case "solve", "bounds":
		if jobPath == "" {
			usage()
		}
		job, err := readJob(jobPath)
		if err != nil {
			fatal(err)
		}
		var state *cut.State
		if statePath != "" {
			state, err = cut.LoadState(statePath)
			if err != nil {
				fatal(err)
			}
			job.Inventory = state.Inventory
			job.History = state.History
			if job.OrderID == "" {
				job.OrderID = fmt.Sprintf("O%d", state.OrderSeq+1)
			}
		}
		if job.OrderID == "" {
			job.OrderID = "O1"
		}
		if cmd == "bounds" {
			writeJSON(cut.ComputeBounds(job))
			return
		}
		plan, err := cut.Solve(job)
		if err != nil {
			fatal(err)
		}
		writeJSON(plan)
		if state != nil {
			state.Apply(plan)
			if err := state.Save(statePath); err != nil {
				fatal(err)
			}
		}
	case "inventory":
		if statePath == "" {
			usage()
		}
		state, err := cut.LoadState(statePath)
		if err != nil {
			fatal(err)
		}
		writeJSON(state.Inventory)
	default:
		usage()
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "cutcli:", err)
	os.Exit(1)
}
