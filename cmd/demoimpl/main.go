// Command demoimpl is a reference implementation speaking the exec adapter
// protocol (JSON lines on stdin/stdout), built from a state table.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"protocheck"
)

func main() {
	tablePath := flag.String("table", "", "path to protocol state table (JSON)")
	flag.Parse()
	if *tablePath == "" {
		fmt.Fprintln(os.Stderr, "-table is required")
		os.Exit(2)
	}
	t, err := protocheck.LoadTable(*tablePath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	sim := protocheck.NewSimAdapter(t)

	dec := json.NewDecoder(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	for {
		var req struct {
			Op     string `json:"op"`
			Action string `json:"action"`
		}
		if err := dec.Decode(&req); err != nil {
			return
		}
		resp := map[string]any{}
		switch req.Op {
		case "reset":
			if err := sim.Reset(); err != nil {
				resp["error"] = err.Error()
			} else {
				resp["ok"] = true
			}
		case "apply":
			if err := sim.Apply(req.Action); err != nil {
				resp["error"] = err.Error()
			} else {
				resp["ok"] = true
			}
		case "state":
			s, err := sim.State()
			if err != nil {
				resp["error"] = err.Error()
			} else {
				resp["ok"] = true
				resp["state"] = s
			}
		default:
			resp["error"] = fmt.Sprintf("unknown op %q", req.Op)
		}
		if err := enc.Encode(resp); err != nil {
			return
		}
	}
}
