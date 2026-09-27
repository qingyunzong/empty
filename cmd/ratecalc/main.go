// Command ratecalc replays a fixture of counter samples and prints the
// windowed rate report. Telemetry is synthesized locally in fixture files;
// no monitoring platform is involved.
//
// Fixture format, one sample per line:
//
//	<seconds> <value> [reset]
//
// Lines starting with # and blank lines are ignored.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"telemetry"
)

func main() {
	fixture := flag.String("fixture", "", "fixture file to replay (required)")
	start := flag.Float64("start", 0, "window start (seconds)")
	end := flag.Float64("end", 0, "window end (seconds)")
	policyName := flag.String("policy", "keep-last", "conflict policy: keep-last|keep-first|keep-max")
	flag.Parse()

	if *fixture == "" {
		flag.Usage()
		os.Exit(2)
	}
	policy, err := parsePolicy(*policyName)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	samples, err := loadFixture(*fixture)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	rep, err := telemetry.Rate(samples, *start, *end, policy)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	fmt.Printf("fixture:  %s (%d samples, policy %s)\n", *fixture, len(samples), *policyName)
	fmt.Printf("window:   [%g, %g] (effective [%g, %g])\n", *start, *end, rep.Start, rep.End)
	fmt.Printf("increase: %g over %gs\n", rep.Increase, rep.End-rep.Start)
	fmt.Printf("rate:     %g/s\n", rep.Rate)
	fmt.Printf("resets:   %d\n", rep.Resets)
	fmt.Printf("uncertain drops (unmarked rollback): %d\n", rep.UncertainDrops)
	fmt.Printf("conflicts (duplicate timestamps):    %d\n", rep.Conflicts)
}

func parsePolicy(name string) (telemetry.ConflictPolicy, error) {
	switch name {
	case "keep-last":
		return telemetry.KeepLast, nil
	case "keep-first":
		return telemetry.KeepFirst, nil
	case "keep-max":
		return telemetry.KeepMax, nil
	}
	return 0, fmt.Errorf("unknown conflict policy %q", name)
}

func loadFixture(path string) ([]telemetry.Sample, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var samples []telemetry.Sample
	scanner := bufio.NewScanner(f)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 || len(fields) > 3 {
			return nil, fmt.Errorf("%s:%d: want \"<seconds> <value> [reset]\", got %q", path, lineNo, line)
		}
		t, err := strconv.ParseFloat(fields[0], 64)
		if err != nil {
			return nil, fmt.Errorf("%s:%d: bad time: %v", path, lineNo, err)
		}
		v, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			return nil, fmt.Errorf("%s:%d: bad value: %v", path, lineNo, err)
		}
		s := telemetry.Sample{T: t, Value: v}
		if len(fields) == 3 {
			if fields[2] != "reset" {
				return nil, fmt.Errorf("%s:%d: unknown marker %q (want \"reset\")", path, lineNo, fields[2])
			}
			s.Reset = true
		}
		samples = append(samples, s)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return samples, nil
}
