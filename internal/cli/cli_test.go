package cli

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func runCLI(t *testing.T, args []string, input string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := Main(append([]string{"travelcli"}, args...), strings.NewReader(input), &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestCoverCommand(t *testing.T) {
	input := `{"days":[1,2,3],"tickets":[
		{"id":"A","cost":5,"days":[1,2]},
		{"id":"B","cost":5,"days":[2,3]},
		{"id":"C","cost":9,"days":[1,2,3]}]}`
	code, out, errOut := runCLI(t, []string{"cover", "-verify"}, input)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	var res struct {
		Cost     int      `json:"cost"`
		Count    int      `json:"count"`
		IDs      []string `json:"ticketIds"`
		Coverage []struct {
			Day      int    `json:"day"`
			TicketID string `json:"ticketId"`
		} `json:"coverage"`
		Verified *bool `json:"verified"`
	}
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("bad json %q: %v", out, err)
	}
	if res.Cost != 9 || res.Count != 1 || len(res.IDs) != 1 || res.IDs[0] != "C" {
		t.Fatalf("got %+v", res)
	}
	if res.Verified == nil || !*res.Verified {
		t.Fatalf("expected verified output, got %+v", res)
	}
	if len(res.Coverage) != 3 {
		t.Fatalf("coverage certificate incomplete: %+v", res.Coverage)
	}
}

func TestActivateCommand(t *testing.T) {
	input := `{"days":[1,2,3],"tickets":[
		{"id":"S","kind":"single","cost":4},
		{"id":"T","kind":"single","cost":4},
		{"id":"U","kind":"single","cost":4},
		{"id":"P","kind":"pass","cost":10,"validity":3}]}`
	code, out, errOut := runCLI(t, []string{"activate", "-verify"}, input)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	var res struct {
		Cost      int `json:"cost"`
		Purchases []struct {
			ID            string `json:"id"`
			ActivationDay int    `json:"activationDay"`
			UsedDays      []int  `json:"usedDays"`
		} `json:"purchases"`
		Daily []struct {
			Day      int    `json:"day"`
			TicketID string `json:"ticketId"`
		} `json:"daily"`
		Verified *bool `json:"verified"`
	}
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("bad json %q: %v", out, err)
	}
	if res.Cost != 10 || len(res.Purchases) != 1 || res.Purchases[0].ID != "P" {
		t.Fatalf("got %+v", res)
	}
	if res.Purchases[0].ActivationDay != 1 || len(res.Purchases[0].UsedDays) != 3 {
		t.Fatalf("bad purchases %+v", res.Purchases)
	}
	if len(res.Daily) != 3 {
		t.Fatalf("daily certificate incomplete: %+v", res.Daily)
	}
	if res.Verified == nil || !*res.Verified {
		t.Fatalf("expected verified output, got %+v", res)
	}
}

func TestInfeasibleExitCode(t *testing.T) {
	code, _, errOut := runCLI(t, []string{"cover"}, `{"days":[1,2],"tickets":[{"id":"A","cost":1,"days":[1]}]}`)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !strings.Contains(errOut, "no feasible solution") {
		t.Fatalf("unexpected stderr %q", errOut)
	}
}

func TestUsageExitCode(t *testing.T) {
	code, _, errOut := runCLI(t, nil, "")
	if code != 2 || !strings.Contains(errOut, "Usage:") {
		t.Fatalf("got code %d stderr %q", code, errOut)
	}
}

func TestInvalidJSON(t *testing.T) {
	code, _, errOut := runCLI(t, []string{"cover"}, `{not json`)
	if code != 1 || !strings.Contains(errOut, "invalid input") {
		t.Fatalf("got code %d stderr %q", code, errOut)
	}
}
