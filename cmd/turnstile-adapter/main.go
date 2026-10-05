// Command turnstile-adapter is a reference adapter for the turnstile
// example model. It speaks the mbt JSON-lines protocol on stdin/stdout.
package main

import (
	"bufio"
	"encoding/json"
	"os"
)

type request struct {
	Op     string `json:"op"`
	Action string `json:"action,omitempty"`
}

type response struct {
	OK    bool           `json:"ok"`
	Error string         `json:"error,omitempty"`
	State string         `json:"state,omitempty"`
	Data  map[string]any `json:"data,omitempty"`
}

func main() {
	state := "locked"
	fare := 0
	snap := func() response {
		return response{OK: true, State: state, Data: map[string]any{"fare": float64(fare)}}
	}
	sc := bufio.NewScanner(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	for sc.Scan() {
		var req request
		if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
			enc.Encode(response{OK: false, Error: "bad request: " + err.Error()})
			continue
		}
		var resp response
		switch req.Op {
		case "reset":
			state, fare = "locked", 0
			resp = snap()
		case "state":
			resp = snap()
		case "apply":
			switch req.Action {
			case "coin":
				fare++
				state = "unlocked"
				resp = snap()
			case "push":
				if state == "locked" {
					resp = response{OK: false, Error: "turnstile is locked"}
				} else {
					state = "locked"
					resp = snap()
				}
			default:
				resp = response{OK: false, Error: "unknown action " + req.Action}
			}
		default:
			resp = response{OK: false, Error: "unknown op " + req.Op}
		}
		enc.Encode(resp)
	}
}
