package norm

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Exit codes returned by Run.
const (
	ExitOK     = 0
	ExitError  = 1
	ExitPaused = 3
)

var errPaused = errors.New("paused")

// Options configures a normalization run.
type Options struct {
	InputPath  string // "" or "-" reads from Stdin
	OutputPath string // "" or "-" writes to Stdout
	StateDir   string // enables checkpoint/resume when non-empty
	MemBudget  int64  // bytes of key/value data held in memory; <= 0 uses a 64 MiB default
	SpansPath  string // optional NDJSON source-span table output
	// PauseAfterSegments, when > 0, requests a checkpointed pause after the
	// given number of segment flushes (testing/automation hook).
	PauseAfterSegments int
	Stdin              io.Reader
	Stdout             io.Writer
	Stderr             io.Writer
}

type norm struct {
	budget      int64
	memUsed     int64
	tmpDir      string
	segDir      string
	stateDir    string
	segCounter  int
	segsFlushed int
	pauseAfter  int
	ctx         context.Context
	inputSHA    string
	src         []byte
	resume      *resumeState
	spans       *spanWriter
}

type resumeState struct {
	offset    int
	rootStart int
	segments  []*segMeta
}

type checkpoint struct {
	Version     int        `json:"version"`
	InputSHA256 string     `json:"inputSHA256"`
	Budget      int64      `json:"budget"`
	Offset      int        `json:"offset"`
	RootStart   int        `json:"rootStart"`
	NextSeg     int        `json:"nextSeg"`
	Segments    []*segMeta `json:"segments"`
}

func (n *norm) pauseRequested() bool {
	if n.pauseAfter > 0 && n.segsFlushed >= n.pauseAfter {
		return true
	}
	select {
	case <-n.ctx.Done():
		return true
	default:
		return false
	}
}

// parseAll normalizes src into out.
func (n *norm) parseAll(src []byte, out io.Writer) error {
	n.src = src
	p := &parser{src: src, n: n}
	if n.resume != nil {
		p.pos = n.resume.offset
		if err := p.object(out, 0, n.resume.rootStart); err != nil {
			return err
		}
		n.recordSpan("$", "object", n.resume.rootStart, p.pos)
		return nil
	}
	if bytes.HasPrefix(src, []byte{0xEF, 0xBB, 0xBF}) {
		p.pos = 3
	}
	if err := p.value(out, 0); err != nil {
		return err
	}
	if err := p.skipWS(); err != nil {
		return err
	}
	if p.pos < len(src) {
		return p.errf(p.pos, "unexpected trailing data after top-level value")
	}
	return nil
}

// Run executes one normalization run and returns a process exit code.
func Run(ctx context.Context, opts Options) int {
	if ctx == nil {
		ctx = context.Background()
	}
	stderr := opts.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}
	fail := func(err error) int {
		fmt.Fprintf(stderr, "jsonnorm: %v\n", err)
		return ExitError
	}

	var src []byte
	var err error
	if opts.InputPath == "" || opts.InputPath == "-" {
		in := opts.Stdin
		if in == nil {
			in = os.Stdin
		}
		src, err = io.ReadAll(in)
	} else {
		src, err = os.ReadFile(opts.InputPath)
	}
	if err != nil {
		return fail(fmt.Errorf("read input: %w", err))
	}

	budget := opts.MemBudget
	if budget <= 0 {
		budget = 64 << 20
	}
	sum := sha256.Sum256(src)
	n := &norm{
		budget:     budget,
		ctx:        ctx,
		pauseAfter: opts.PauseAfterSegments,
		stateDir:   opts.StateDir,
		inputSHA:   hex.EncodeToString(sum[:]),
	}

	if opts.StateDir != "" {
		if err := os.MkdirAll(opts.StateDir, 0o755); err != nil {
			return fail(fmt.Errorf("create state directory: %w", err))
		}
		n.segDir = opts.StateDir
		n.tmpDir = opts.StateDir
		data, err := os.ReadFile(filepath.Join(opts.StateDir, "checkpoint.json"))
		switch {
		case err == nil:
			if err := n.loadCheckpoint(data, src); err != nil {
				return fail(err)
			}
		case !os.IsNotExist(err):
			return fail(fmt.Errorf("read checkpoint: %w", err))
		}
	} else {
		tmp, err := os.MkdirTemp("", "jsonnorm-")
		if err != nil {
			return fail(err)
		}
		defer os.RemoveAll(tmp)
		n.tmpDir = tmp
		n.segDir = tmp
	}

	if opts.SpansPath != "" {
		sw, err := openSpanWriter(opts.SpansPath, n.resume != nil)
		if err != nil {
			return fail(fmt.Errorf("open spans file: %w", err))
		}
		n.spans = sw
		defer sw.close()
	}

	toFile := opts.OutputPath != "" && opts.OutputPath != "-"
	var bw *bufio.Writer
	var outFile *os.File
	tmpOut := ""
	stdoutTmp := ""
	if toFile {
		tmpOut = opts.OutputPath + ".part"
		outFile, err = os.OpenFile(tmpOut, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return fail(fmt.Errorf("create output: %w", err))
		}
		bw = bufio.NewWriter(outFile)
	} else {
		// stdout is staged through a temporary file as well, so bad input
		// never produces a partial normalized document anywhere.
		outFile, err = os.CreateTemp("", "jsonnorm-out-")
		if err != nil {
			return fail(err)
		}
		stdoutTmp = outFile.Name()
		bw = bufio.NewWriter(outFile)
	}

	// The normalized document is only published atomically: it is written
	// to a temporary file and renamed (or copied to stdout) on success, so
	// bad input never leaves a partial normalized file behind.
	publish := func() error {
		if err := bw.Flush(); err != nil {
			return err
		}
		if stdoutTmp != "" {
			if _, err := outFile.Seek(0, 0); err != nil {
				return err
			}
			w := opts.Stdout
			if w == nil {
				w = os.Stdout
			}
			if _, err := io.Copy(w, outFile); err != nil {
				return err
			}
			return nil
		}
		if err := outFile.Sync(); err != nil {
			return err
		}
		if err := outFile.Close(); err != nil {
			return err
		}
		return os.Rename(tmpOut, opts.OutputPath)
	}
	discard := func() {
		bw.Flush()
		if outFile != nil {
			outFile.Close()
		}
		if tmpOut != "" {
			os.Remove(tmpOut)
		}
		if stdoutTmp != "" {
			os.Remove(stdoutTmp)
		}
	}

	perr := n.parseAll(src, bw)
	switch {
	case perr == errPaused:
		discard()
		fmt.Fprintln(stderr, "jsonnorm: paused; checkpoint written, rerun with the same -state directory to resume")
		return ExitPaused
	case perr != nil:
		discard()
		return fail(perr)
	}
	if err := publish(); err != nil {
		discard()
		return fail(fmt.Errorf("publish output: %w", err))
	}
	if stdoutTmp != "" {
		outFile.Close()
		os.Remove(stdoutTmp)
	}
	if opts.StateDir != "" {
		os.Remove(filepath.Join(opts.StateDir, "checkpoint.json"))
		if matches, _ := filepath.Glob(filepath.Join(opts.StateDir, "seg-*.bin")); true {
			for _, m := range matches {
				os.Remove(m)
			}
		}
	}
	return ExitOK
}

func (n *norm) writeCheckpoint(offset, rootStart int, segs []*segMeta) error {
	cp := checkpoint{
		Version:     1,
		InputSHA256: n.inputSHA,
		Budget:      n.budget,
		Offset:      offset,
		RootStart:   rootStart,
		NextSeg:     n.segCounter,
		Segments:    segs,
	}
	data, err := json.MarshalIndent(&cp, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(n.stateDir, "checkpoint.json.tmp")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(n.stateDir, "checkpoint.json"))
}

// loadCheckpoint validates a checkpoint against the current input: the
// SHA-256 of the original input must match, the memory budget must be the
// same, and every recorded segment file must pass an integrity check.
func (n *norm) loadCheckpoint(data []byte, src []byte) error {
	var cp checkpoint
	if err := json.Unmarshal(data, &cp); err != nil {
		return fmt.Errorf("parse checkpoint: %w", err)
	}
	if cp.Version != 1 {
		return fmt.Errorf("unsupported checkpoint version %d", cp.Version)
	}
	sum := sha256.Sum256(src)
	if hex.EncodeToString(sum[:]) != cp.InputSHA256 {
		return errors.New("cannot resume: input changed since checkpoint (sha256 mismatch); remove the state directory to start over")
	}
	if cp.Budget != n.budget {
		return fmt.Errorf("cannot resume: memory budget %d does not match checkpoint budget %d", n.budget, cp.Budget)
	}
	if cp.Offset < 0 || cp.Offset > len(src) {
		return errors.New("corrupt checkpoint: offset out of range")
	}
	for _, m := range cp.Segments {
		f, err := os.Open(filepath.Join(n.stateDir, m.File))
		if err != nil {
			return fmt.Errorf("cannot resume: %w", err)
		}
		h := sha256.New()
		nbytes, err := io.Copy(h, f)
		f.Close()
		if err != nil {
			return fmt.Errorf("cannot resume: read segment: %w", err)
		}
		if nbytes != m.Bytes || hex.EncodeToString(h.Sum(nil)) != m.SHA256 {
			return fmt.Errorf("cannot resume: segment %s failed integrity check", m.File)
		}
	}
	n.resume = &resumeState{offset: cp.Offset, rootStart: cp.RootStart, segments: cp.Segments}
	n.segCounter = cp.NextSeg
	return nil
}
