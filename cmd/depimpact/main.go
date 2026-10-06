// Command depimpact reads an old dependency graph, a new dependency graph
// and a change set (all JSON), then prints the per-test impact report.
//
//	depimpact -old old.json -new new.json -changes changes.json
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"depimpact"
)

func main() {
	oldPath := flag.String("old", "", "old dependency graph JSON")
	newPath := flag.String("new", "", "new dependency graph JSON")
	csPath := flag.String("changes", "", "change set JSON")
	flag.Parse()

	var oldG, newG *depimpact.Graph
	var err error
	if *oldPath != "" {
		if oldG, err = depimpact.LoadGraph(*oldPath); err != nil {
			fatal(err)
		}
	}
	if *newPath != "" {
		if newG, err = depimpact.LoadGraph(*newPath); err != nil {
			fatal(err)
		}
	}
	cs := &depimpact.ChangeSet{}
	if *csPath != "" {
		if cs, err = depimpact.LoadChangeSet(*csPath); err != nil {
			fatal(err)
		}
	}

	out, err := json.MarshalIndent(depimpact.Analyze(oldG, newG, cs), "", "  ")
	if err != nil {
		fatal(err)
	}
	fmt.Println(string(out))
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
