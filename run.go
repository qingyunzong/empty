package jsoncanon

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// RunOptions drives a full file-to-file canonicalization run.
type RunOptions struct {
	InputPath  string
	OutputPath string
	SpansPath  string // optional: write source spans JSON here
	MemBudget  int64  // bytes per object sort buffer; <= 0 = unlimited
	TempDir    string // external-sort temp dir; empty = auto
	StatePath  string // checkpoint state file; enables pause/resume
	Resume     bool   // resume from StatePath (verifies input hash)

	// PauseAfterSegments, if > 0, makes the run checkpoint and return
	// ErrPaused after writing that many new sort segments.
	PauseAfterSegments int
}

// Run canonicalizes InputPath and atomically publishes strict JSON to
// OutputPath. Bad input never produces a partial output file: the output
// is written to a temporary sibling and renamed only on full success.
func Run(opts RunOptions) error {
	src, err := os.ReadFile(opts.InputPath)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(src)
	hash := hex.EncodeToString(sum[:])

	canonOpts := &Options{
		MemBudget:          opts.MemBudget,
		TempDir:            opts.TempDir,
		CollectSpans:       opts.SpansPath != "",
		StatePath:          opts.StatePath,
		InputHash:          hash,
		PauseAfterSegments: opts.PauseAfterSegments,
	}
	autoTemp := false

	if opts.Resume {
		st, err := readStateFile(opts.StatePath)
		if err != nil {
			return fmt.Errorf("resume: %w", err)
		}
		if st.InputHash != hash {
			return errors.New("resume: input file changed since checkpoint (hash mismatch); refusing to resume")
		}
		if st.MemBudget != opts.MemBudget {
			return errors.New("resume: memory budget differs from checkpoint; refusing to resume")
		}
		canonOpts.TempDir = st.TempDir
		canonOpts.ReuseSegments = st.Segments
	}
	if opts.StatePath != "" && canonOpts.TempDir == "" {
		// Checkpointing needs a temp dir that survives the pause.
		d, err := os.MkdirTemp("", "jsoncanon-state-")
		if err != nil {
			return err
		}
		canonOpts.TempDir = d
		autoTemp = true
	}

	v, err := Parse(src)
	if err != nil {
		return err
	}

	tmpOut := opts.OutputPath + ".tmp"
	out, err := os.Create(tmpOut)
	if err != nil {
		return err
	}
	res, werr := WriteCanonical(out, v, canonOpts)
	if werr == nil {
		werr = out.Sync()
	}
	cerr := out.Close()
	if werr != nil {
		os.Remove(tmpOut)
		return werr
	}
	if cerr != nil {
		os.Remove(tmpOut)
		return cerr
	}

	// Prepare spans file before publishing anything.
	tmpSpans := ""
	if opts.SpansPath != "" {
		tmpSpans = opts.SpansPath + ".tmp"
		data, err := json.MarshalIndent(res.Spans, "", "  ")
		if err != nil {
			os.Remove(tmpOut)
			return err
		}
		if err := os.WriteFile(tmpSpans, data, 0o644); err != nil {
			os.Remove(tmpOut)
			return err
		}
	}

	// Publish: spans first, canonical output last.
	if tmpSpans != "" {
		if err := os.Rename(tmpSpans, opts.SpansPath); err != nil {
			os.Remove(tmpOut)
			os.Remove(tmpSpans)
			return err
		}
	}
	if err := os.Rename(tmpOut, opts.OutputPath); err != nil {
		os.Remove(tmpOut)
		return err
	}

	// Success: clean up checkpoint state and temp segments.
	if opts.StatePath != "" {
		os.Remove(opts.StatePath)
		if autoTemp {
			os.RemoveAll(canonOpts.TempDir)
		} else if canonOpts.TempDir != "" {
			os.RemoveAll(canonOpts.TempDir + string(os.PathSeparator) + "root-obj")
		}
	}
	return nil
}
