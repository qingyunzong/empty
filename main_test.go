package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseDays(t *testing.T) {
	days, err := parseDays("1-3,5")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(days, []int{1, 2, 3, 5}) {
		t.Fatalf("got %v", days)
	}
	days, err = parseDays("7")
	if err != nil || !reflect.DeepEqual(days, []int{7}) {
		t.Fatalf("got %v, %v", days, err)
	}
	for _, bad := range []string{"", "a", "3-1", "1,,2", "1-"} {
		if _, err := parseDays(bad); err == nil {
			t.Fatalf("expected error for %q", bad)
		}
	}
}

func writeTickets(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tickets.json")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRunCoverCLI(t *testing.T) {
	path := writeTickets(t, `[
	  {"id":"A","kind":"区间票","price":5,"days":[1,2,3]},
	  {"id":"B","kind":"单程票","price":4,"days":[3,4,5]},
	  {"id":"C","kind":"通票","price":3,"days":[1,2,3]},
	  {"id":"D","kind":"通票","price":3,"days":[3,4,5]}
	]`)
	var out bytes.Buffer
	code := run([]string{"cover", "-days", "1-5", "-tickets", path, "-verify"}, &out)
	if code != 0 {
		t.Fatalf("exit %d, output:\n%s", code, out.String())
	}
	s := out.String()
	for _, want := range []string{"最小费用: 6", "购票: C, D", "第 3 天 -> 车票 C", "穷举核验通过"} {
		if !strings.Contains(s, want) {
			t.Fatalf("output missing %q:\n%s", want, s)
		}
	}
}

func TestRunCoverCLIJSON(t *testing.T) {
	path := writeTickets(t, `[{"id":"A","price":4,"days":[1,2]}]`)
	var out bytes.Buffer
	code := run([]string{"cover", "-days", "1,2", "-tickets", path, "-json"}, &out)
	if code != 0 {
		t.Fatalf("exit %d, output:\n%s", code, out.String())
	}
	var cert CoverCert
	if err := json.Unmarshal(out.Bytes(), &cert); err != nil {
		t.Fatal(err)
	}
	if cert.Cost != 4 || cert.DayCover[1] != "A" || cert.DayCover[2] != "A" {
		t.Fatalf("got %+v", cert)
	}
}

func TestRunActivateCLI(t *testing.T) {
	path := writeTickets(t, `[
	  {"id":"A","price":10,"validDays":2,"maxUses":2},
	  {"id":"B","price":6,"validDays":1,"maxUses":1}
	]`)
	var out bytes.Buffer
	code := run([]string{"activate", "-days", "1,2,4", "-tickets", path, "-verify"}, &out)
	if code != 0 {
		t.Fatalf("exit %d, output:\n%s", code, out.String())
	}
	s := out.String()
	for _, want := range []string{"最小费用: 16", "A(第 1 天激活)", "B(第 4 天激活)", "第 4 天 -> 车票 B", "穷举核验通过"} {
		if !strings.Contains(s, want) {
			t.Fatalf("output missing %q:\n%s", want, s)
		}
	}
}

func TestRunActivateCLIJSON(t *testing.T) {
	path := writeTickets(t, `[{"id":"A","price":10,"validDays":2,"maxUses":2},{"id":"B","price":6,"validDays":1,"maxUses":1}]`)
	var out bytes.Buffer
	code := run([]string{"activate", "-days", "1,2,4", "-tickets", path, "-json"}, &out)
	if code != 0 {
		t.Fatalf("exit %d, output:\n%s", code, out.String())
	}
	var cert ActCert
	if err := json.Unmarshal(out.Bytes(), &cert); err != nil {
		t.Fatal(err)
	}
	if cert.Cost != 16 || cert.ActivateOn["A"] != 1 || cert.ActivateOn["B"] != 4 || cert.DayUse[4] != "B" {
		t.Fatalf("got %+v", cert)
	}
}

func TestRunInfeasibleExitCode(t *testing.T) {
	path := writeTickets(t, `[{"id":"A","price":1,"days":[1]}]`)
	var out bytes.Buffer
	if code := run([]string{"cover", "-days", "1,2", "-tickets", path}, &out); code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if code := run([]string{}, &out); code != 2 {
		t.Fatalf("expected exit 2 for usage, got %d", code)
	}
}
