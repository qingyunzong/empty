// Command corrector prints the minimum delete/insert script aligning a
// scanned barcode sequence with the expected item order.
//
// Usage:
//
//	corrector -expected expected.txt -scanned scanned.txt
//
// Each input file lists one barcode per line. The tool prints the edit
// distance followed by the replayable script.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"strings"

	"corrector"
)

func readLines(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines, sc.Err()
}

func main() {
	expectedPath := flag.String("expected", "", "file with the expected item order, one barcode per line")
	scannedPath := flag.String("scanned", "", "file with the scanned sequence, one barcode per line")
	flag.Parse()
	if *expectedPath == "" || *scannedPath == "" {
		fmt.Fprintln(os.Stderr, "both -expected and -scanned are required")
		os.Exit(2)
	}
	expected, err := readLines(*expectedPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	scanned, err := readLines(*scannedPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	script := corrector.Diff(expected, scanned)
	fmt.Printf("distance: %d\n", len(script))
	fmt.Print(script)

	got, err := script.Apply(scanned)
	if err != nil {
		fmt.Fprintln(os.Stderr, "replay failed:", err)
		os.Exit(1)
	}
	if strings.Join(got, "\x00") != strings.Join(expected, "\x00") {
		fmt.Fprintln(os.Stderr, "replay mismatch")
		os.Exit(1)
	}
}
