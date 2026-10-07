package imgdiff

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
)

// ImageJSON is the wire format of an extent list.
type ImageJSON struct {
	Size    uint64       `json:"size"`
	Extents []ExtentJSON `json:"extents"`
}

// ExtentJSON is the wire format of one extent. Data is base64.
type ExtentJSON struct {
	Start  uint64 `json:"start"`
	Len    uint64 `json:"len"`
	Kind   string `json:"kind"` // "data" or "hole"
	Shared bool   `json:"shared,omitempty"`
	Data   string `json:"data,omitempty"`
}

// ImageFromJSON decodes and validates an extent list.
func ImageFromJSON(j *ImageJSON) (*Image, error) {
	img := &Image{Size: j.Size}
	for i, e := range j.Extents {
		ext := Extent{Start: e.Start, Len: e.Len, Shared: e.Shared}
		switch e.Kind {
		case "data":
			ext.Kind = Data
			b, err := base64.StdEncoding.DecodeString(e.Data)
			if err != nil {
				return nil, fmt.Errorf("imgdiff: extent %d: bad base64 data: %w", i, err)
			}
			ext.Data = b
		case "hole":
			ext.Kind = Hole
			ext.Shared = false
		default:
			return nil, fmt.Errorf("imgdiff: extent %d: kind must be \"data\" or \"hole\", got %q", i, e.Kind)
		}
		img.Extents = append(img.Extents, ext)
	}
	if err := img.Validate(); err != nil {
		return nil, err
	}
	return img, nil
}

// ToJSON encodes an image as an extent list.
func (img *Image) ToJSON() *ImageJSON {
	j := &ImageJSON{Size: img.Size}
	for _, e := range img.Extents {
		je := ExtentJSON{Start: e.Start, Len: e.Len, Kind: e.Kind.String(), Shared: e.Shared}
		if e.Kind == Data {
			je.Data = base64.StdEncoding.EncodeToString(e.Data)
		}
		j.Extents = append(j.Extents, je)
	}
	return j
}

// ParseImageJSON decodes an extent list from JSON bytes.
func ParseImageJSON(b []byte) (*Image, error) {
	var j ImageJSON
	if err := json.Unmarshal(b, &j); err != nil {
		return nil, fmt.Errorf("imgdiff: %w", err)
	}
	return ImageFromJSON(&j)
}

// PlanJSON is the wire format of a relocation plan.
type PlanJSON struct {
	BlockSize uint64     `json:"blockSize"`
	Steps     []StepJSON `json:"steps"`
}

// StepJSON is the wire format of one plan step.
type StepJSON struct {
	Op      string `json:"op"`
	Src     int    `json:"src,omitempty"`
	Dst     int    `json:"dst,omitempty"`
	Data    string `json:"data,omitempty"`
	SrcHash uint64 `json:"srcHash,omitempty"`
}

// ToJSON encodes a plan.
func (p *Plan) ToJSON() *PlanJSON {
	j := &PlanJSON{BlockSize: p.BlockSize}
	for _, s := range p.Steps {
		js := StepJSON{Op: s.Op.String(), Src: s.Src, Dst: s.Dst, SrcHash: s.SrcHash}
		if s.Op == OpWrite {
			js.Data = base64.StdEncoding.EncodeToString(s.Data)
		}
		j.Steps = append(j.Steps, js)
	}
	return j
}

// PlanFromJSON decodes and structurally checks a plan.
func PlanFromJSON(j *PlanJSON) (*Plan, error) {
	if j.BlockSize == 0 {
		return nil, fmt.Errorf("imgdiff: plan block size must be > 0")
	}
	p := &Plan{BlockSize: j.BlockSize}
	for i, js := range j.Steps {
		s := Step{Src: js.Src, Dst: js.Dst, SrcHash: js.SrcHash}
		switch js.Op {
		case "move":
			s.Op = OpMove
		case "write":
			s.Op = OpWrite
			b, err := base64.StdEncoding.DecodeString(js.Data)
			if err != nil {
				return nil, fmt.Errorf("imgdiff: step %d: bad base64 data: %w", i, err)
			}
			s.Data = b
		case "punch":
			s.Op = OpPunch
		case "unshare":
			s.Op = OpUnshare
		case "stage-save":
			s.Op = OpStageSave
		case "stage-load":
			s.Op = OpStageLoad
		default:
			return nil, fmt.Errorf("imgdiff: step %d: unknown op %q", i, js.Op)
		}
		p.Steps = append(p.Steps, s)
	}
	return p, nil
}

// ParsePlanJSON decodes a plan from JSON bytes.
func ParsePlanJSON(b []byte) (*Plan, error) {
	var j PlanJSON
	if err := json.Unmarshal(b, &j); err != nil {
		return nil, fmt.Errorf("imgdiff: %w", err)
	}
	return PlanFromJSON(&j)
}

// MachineJSON is a serializable machine snapshot for crash/resume.
type MachineJSON struct {
	BlockSize uint64   `json:"blockSize"`
	Blocks    []string `json:"blocks"`  // base64 content per block; "" for holes
	Holes     []bool   `json:"holes"`   // holes[i] true if block i is a hole
	Shared    []bool   `json:"shared"`  // shared[i] true if block i is still shared
	Parent    []string `json:"parent"`  // base64 parent content per originally shared block
	Staging   string   `json:"staging"` // base64 staging block, "" if empty
	HasStage  bool     `json:"hasStage"`
	Next      int      `json:"next"` // journal: next step to execute
}

// MarshalState snapshots the machine for later resumption.
func (m *Machine) MarshalState() *MachineJSON {
	j := &MachineJSON{BlockSize: m.BlockSize, HasStage: m.hasStage, Next: m.Next}
	for _, b := range m.blocks {
		j.Holes = append(j.Holes, b.hole)
		j.Shared = append(j.Shared, b.shared)
		s := ""
		if !b.hole {
			s = base64.StdEncoding.EncodeToString(b.data)
		}
		j.Blocks = append(j.Blocks, s)
	}
	for _, p := range m.parent {
		s := ""
		if p != nil {
			s = base64.StdEncoding.EncodeToString(p)
		}
		j.Parent = append(j.Parent, s)
	}
	if m.hasStage {
		j.Staging = base64.StdEncoding.EncodeToString(m.staging)
	}
	return j
}

// MachineFromState restores a machine snapshot.
func MachineFromState(j *MachineJSON) (*Machine, error) {
	m := &Machine{BlockSize: j.BlockSize, hasStage: j.HasStage, Next: j.Next}
	if len(j.Blocks) != len(j.Holes) || len(j.Blocks) != len(j.Shared) || len(j.Blocks) != len(j.Parent) {
		return nil, fmt.Errorf("imgdiff: corrupt state: block arrays differ in length")
	}
	for i := range j.Blocks {
		mb := mblock{hole: j.Holes[i], shared: j.Shared[i]}
		if !mb.hole {
			b, err := base64.StdEncoding.DecodeString(j.Blocks[i])
			if err != nil {
				return nil, fmt.Errorf("imgdiff: state block %d: %w", i, err)
			}
			mb.data = b
		}
		m.blocks = append(m.blocks, mb)
		var p []byte
		if j.Parent[i] != "" {
			b, err := base64.StdEncoding.DecodeString(j.Parent[i])
			if err != nil {
				return nil, fmt.Errorf("imgdiff: state parent %d: %w", i, err)
			}
			p = b
		}
		m.parent = append(m.parent, p)
	}
	if m.hasStage {
		b, err := base64.StdEncoding.DecodeString(j.Staging)
		if err != nil {
			return nil, fmt.Errorf("imgdiff: state staging: %w", err)
		}
		m.staging = b
	}
	return m, nil
}

// ParentSnapshot exposes a copy of the parent store for verification.
func (m *Machine) ParentSnapshot() [][]byte { return m.parentSnapshot() }
