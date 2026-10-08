package bchandler

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// Spec is the JSON input document for the CLI.
type Spec struct {
	// Code lists instruction mnemonics; Length is used when Code is empty.
	Code     []string      `json:"code"`
	Length   int           `json:"length"`
	Handlers []HandlerSpec `json:"handlers"`
	// Inserts are applied in order; each position refers to the code state
	// at the moment of that insertion.
	Inserts []InsertSpec `json:"insert"`
}

// HandlerSpec is the JSON form of a Handler; Order is the slice index.
type HandlerSpec struct {
	Name  string `json:"name"`
	Start int    `json:"start"`
	End   int    `json:"end"`
	Type  string `json:"type"`
}

// InsertSpec inserts Count instructions before index At.
type InsertSpec struct {
	At    int `json:"at"`
	Count int `json:"count"`
}

// LoadSpec reads and parses a JSON spec file.
func LoadSpec(path string) (Spec, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Spec{}, err
	}
	var spec Spec
	if err := json.Unmarshal(data, &spec); err != nil {
		return Spec{}, fmt.Errorf("parsing %s: %w", path, err)
	}
	return spec, nil
}

// CodeLen returns the effective instruction count of the spec.
func (s Spec) CodeLen() int {
	if len(s.Code) > 0 {
		return len(s.Code)
	}
	return s.Length
}

// HandlerList converts the spec handlers into ordered Handler values.
func (s Spec) HandlerList() []Handler {
	hs := make([]Handler, len(s.Handlers))
	for i, h := range s.Handlers {
		name := h.Name
		if name == "" {
			name = fmt.Sprintf("h%d", i)
		}
		hs[i] = Handler{Name: name, Start: h.Start, End: h.End, Type: h.Type, Order: i}
	}
	return hs
}

func (s Spec) opcode(pc int) string {
	if pc < len(s.Code) {
		return s.Code[pc]
	}
	return fmt.Sprintf("op_%d", pc)
}

func chainString(chain []Handler) string {
	if len(chain) == 0 {
		return "-"
	}
	parts := make([]string, len(chain))
	for i, h := range chain {
		if h.Type != "" {
			parts[i] = fmt.Sprintf("%s(%s)", h.Name, h.Type)
		} else {
			parts[i] = h.Name
		}
	}
	return strings.Join(parts, " > ")
}

// Report validates the spec, prints the effective handler chain for every
// instruction, then applies the insertions (plus any extra ones) and prints
// the remapped handlers and the chains of the extended code.
func Report(spec Spec, extra []InsertSpec, out io.Writer) error {
	codeLen := spec.CodeLen()
	if codeLen < 0 {
		return fmt.Errorf("negative code length %d", codeLen)
	}
	hs := spec.HandlerList()
	if err := ValidateHandlers(hs, codeLen); err != nil {
		return fmt.Errorf("invalid handler table: %w", err)
	}

	forest := BuildForest(hs)
	fmt.Fprintf(out, "code length: %d\n", codeLen)
	fmt.Fprintf(out, "handlers: %d (valid, no crossing intervals)\n", len(hs))
	printChains(out, spec, forest, codeLen)

	inserts := append(append([]InsertSpec{}, spec.Inserts...), extra...)
	for step, ins := range inserts {
		if ins.At > codeLen {
			return fmt.Errorf("insert %d: position %d exceeds code length %d", step, ins.At, codeLen)
		}
		remapped, err := InsertInstructions(hs, ins.At, ins.Count)
		if err != nil {
			return fmt.Errorf("insert %d: %w", step, err)
		}
		hs = remapped
		codeLen += ins.Count
		fmt.Fprintf(out, "\nafter inserting %d instruction(s) at %d (code length %d):\n", ins.Count, ins.At, codeLen)
		for _, h := range hs {
			fmt.Fprintf(out, "  handler %-12s [%d,%d)\n", h.Name, h.Start, h.End)
		}
		if err := ValidateHandlers(hs, codeLen); err != nil {
			return fmt.Errorf("insert %d broke handler table: %w", step, err)
		}
		forest = BuildForest(hs)
		printChains(out, Spec{Length: codeLen}, forest, codeLen)
	}
	return nil
}

func printChains(out io.Writer, spec Spec, forest []*node, codeLen int) {
	fmt.Fprintf(out, "%-4s %-12s %s\n", "pc", "opcode", "effective handler chain (innermost first)")
	for pc := 0; pc < codeLen; pc++ {
		fmt.Fprintf(out, "%-4d %-12s %s\n", pc, spec.opcode(pc), chainString(Chain(forest, pc)))
	}
}
