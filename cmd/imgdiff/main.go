// Command imgdiff compares sparse images described by extent lists and
// plans/executes relocations turning an old image into a new one.
//
// Usage:
//
//	imgdiff diff  <old.json> <new.json>
//	imgdiff plan  -block N <old.json> <new.json>
//	imgdiff exec  [-state f] [-crash-at K] [-resume] <old.json> <new.json> <plan.json>
//
// Extent lists are JSON: {"size": N, "extents": [{"start","len","kind",
// "shared","data"}...]} with kind "data"|"hole" and base64 data. Holes read
// as zeros; a zero data block and a hole are content-equal but differ in
// layout. diff prints maximal half-open content and layout difference
// intervals. exec independently executes a plan, verifying final content,
// hole layout and parent snapshot integrity; with -crash-at it stops after
// K steps and -resume continues from the journaled state.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"imgdiff"
)

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "imgdiff:", err)
	os.Exit(1)
}

func readFile(path string) []byte {
	b, err := os.ReadFile(path)
	if err != nil {
		fatal(err)
	}
	return b
}

func loadImage(path string) *imgdiff.Image {
	img, err := imgdiff.ParseImageJSON(readFile(path))
	if err != nil {
		fatal(fmt.Errorf("%s: %w", path, err))
	}
	return img
}

func writeJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		fatal(err)
	}
}

func cmdDiff(args []string) error {
	fs := flag.NewFlagSet("diff", flag.ExitOnError)
	fs.Parse(args)
	if fs.NArg() != 2 {
		return fmt.Errorf("usage: imgdiff diff <old.json> <new.json>")
	}
	oldImg, newImg := loadImage(fs.Arg(0)), loadImage(fs.Arg(1))
	content, err := imgdiff.ContentDiff(oldImg, newImg)
	if err != nil {
		return err
	}
	layout, err := imgdiff.LayoutDiff(oldImg, newImg)
	if err != nil {
		return err
	}
	toPairs := func(ivs []imgdiff.Interval) [][2]uint64 {
		out := make([][2]uint64, 0, len(ivs))
		for _, iv := range ivs {
			out = append(out, [2]uint64{iv.Start, iv.End})
		}
		return out
	}
	writeJSON(map[string]any{
		"content": toPairs(content),
		"layout":  toPairs(layout),
	})
	return nil
}

func cmdPlan(args []string) error {
	fs := flag.NewFlagSet("plan", flag.ExitOnError)
	block := fs.Uint64("block", 4096, "block size in bytes")
	fs.Parse(args)
	if fs.NArg() != 2 {
		return fmt.Errorf("usage: imgdiff plan -block N <old.json> <new.json>")
	}
	oldImg, newImg := loadImage(fs.Arg(0)), loadImage(fs.Arg(1))
	plan, err := imgdiff.BuildPlan(oldImg, newImg, *block)
	if err != nil {
		return err
	}
	writeJSON(plan.ToJSON())
	return nil
}

func cmdExec(args []string) error {
	fs := flag.NewFlagSet("exec", flag.ExitOnError)
	state := fs.String("state", "", "machine state file for crash/resume")
	crashAt := fs.Int("crash-at", -1, "stop after K steps, saving state (simulated interruption)")
	resume := fs.Bool("resume", false, "resume from the state file instead of the old image")
	fs.Parse(args)
	if fs.NArg() != 3 {
		return fmt.Errorf("usage: imgdiff exec [-state f] [-crash-at K] [-resume] <old.json> <new.json> <plan.json>")
	}
	oldImg, newImg := loadImage(fs.Arg(0)), loadImage(fs.Arg(1))
	plan, err := imgdiff.ParsePlanJSON(readFile(fs.Arg(2)))
	if err != nil {
		return err
	}

	var m *imgdiff.Machine
	if *resume {
		if *state == "" {
			return fmt.Errorf("-resume requires -state")
		}
		var st imgdiff.MachineJSON
		if err := json.Unmarshal(readFile(*state), &st); err != nil {
			return err
		}
		m, err = imgdiff.MachineFromState(&st)
		if err != nil {
			return err
		}
	} else {
		m, err = imgdiff.NewMachine(oldImg, plan.BlockSize)
		if err != nil {
			return err
		}
	}
	parentBefore := m.ParentSnapshot()

	save := func() error {
		if *state == "" {
			return nil
		}
		b, err := json.MarshalIndent(m.MarshalState(), "", "  ")
		if err != nil {
			return err
		}
		return os.WriteFile(*state, b, 0o644)
	}

	done := 0
	for m.Next < len(plan.Steps) {
		if *crashAt >= 0 && done >= *crashAt {
			if err := save(); err != nil {
				return err
			}
			fmt.Printf("interrupted after step %d/%d; resume with -resume\n", m.Next, len(plan.Steps))
			return nil
		}
		if err := m.Step(plan); err != nil {
			return err
		}
		done++
		if err := save(); err != nil { // journal progress after every step
			return err
		}
	}
	if err := m.Verify(newImg, parentBefore); err != nil {
		return err
	}
	fmt.Printf("OK: %d steps executed; content, hole layout and parent snapshot verified\n", len(plan.Steps))
	return nil
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: imgdiff <diff|plan|exec> ...")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "diff":
		err = cmdDiff(os.Args[2:])
	case "plan":
		err = cmdPlan(os.Args[2:])
	case "exec":
		err = cmdExec(os.Args[2:])
	default:
		err = fmt.Errorf("unknown subcommand %q", os.Args[1])
	}
	if err != nil {
		fatal(err)
	}
}
