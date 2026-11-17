package formal

import (
	"fmt"
	"sort"
	"testing"
)

type scheduleKind uint8

const (
	opBegin scheduleKind = iota
	opRead
	opWrite
	opCommit
	opAbort
)

func (k scheduleKind) String() string {
	switch k {
	case opBegin:
		return "begin"
	case opRead:
		return "read"
	case opWrite:
		return "write"
	case opCommit:
		return "commit"
	case opAbort:
		return "abort"
	default:
		return "?"
	}
}

type scheduleOp struct {
	kind     scheduleKind
	tx       int
	key      string
	readOnly bool
}

func (op scheduleOp) String() string {
	if op.key == "" {
		return fmt.Sprintf("T%d.%s", op.tx, op.kind)
	}
	return fmt.Sprintf("T%d.%s(%s)", op.tx, op.kind, op.key)
}

func forEachInterleaving(programs [][]scheduleOp, visit func([]scheduleOp)) {
	total := 0
	for _, program := range programs {
		total += len(program)
	}
	positions := make([]int, len(programs))
	schedule := make([]scheduleOp, 0, total)

	var walk func()
	walk = func() {
		if len(schedule) == total {
			visit(schedule)
			return
		}
		for tx := range programs {
			if positions[tx] == len(programs[tx]) {
				continue
			}
			op := programs[tx][positions[tx]]
			positions[tx]++
			schedule = append(schedule, op)
			walk()
			schedule = schedule[:len(schedule)-1]
			positions[tx]--
		}
	}
	walk()
}

type simVersion struct {
	writer int
	order  int
}

type simRead struct {
	reader  int
	key     string
	version int
}

type oracleResult struct {
	cyclic     bool
	wwConflict bool
}

// simulateIntendedHistory treats every scheduled commit as successful. This is
// the history SSI must either permit in its entirety or cut with an abort.
func simulateIntendedHistory(programs [][]scheduleOp, schedule []scheduleOp) oracleResult {
	n := len(programs)
	beginSnapshot := make([]int, n)
	pending := make([]map[string]struct{}, n)
	local := make([]map[string]struct{}, n)
	for i := range pending {
		pending[i] = make(map[string]struct{})
		local[i] = make(map[string]struct{})
	}

	versions := make(map[string][]simVersion)
	var reads []simRead
	commitCount := 0
	wwConflict := false

	for _, op := range schedule {
		switch op.kind {
		case opBegin:
			beginSnapshot[op.tx] = commitCount
		case opRead:
			if _, ok := local[op.tx][op.key]; ok {
				reads = append(reads, simRead{reader: op.tx, key: op.key, version: -2})
				continue
			}
			index := -1
			list := versions[op.key]
			for i := len(list) - 1; i >= 0; i-- {
				if list[i].order < beginSnapshot[op.tx] {
					index = i
					break
				}
			}
			reads = append(reads, simRead{reader: op.tx, key: op.key, version: index})
		case opWrite:
			pending[op.tx][op.key] = struct{}{}
			local[op.tx][op.key] = struct{}{}
		case opCommit:
			keys := sortedKeys(pending[op.tx])
			for _, key := range keys {
				list := versions[key]
				if len(list) != 0 && list[len(list)-1].order >= beginSnapshot[op.tx] {
					wwConflict = true
				}
				versions[key] = append(versions[key], simVersion{writer: op.tx, order: commitCount})
			}
			commitCount++
		case opAbort:
			// Exhaustive programs currently never abort on their own.
		}
	}

	edges := make([][]bool, n)
	for i := range edges {
		edges[i] = make([]bool, n)
	}
	add := func(from, to int) {
		if from >= 0 && to >= 0 && from != to {
			edges[from][to] = true
		}
	}

	for _, list := range versions {
		for i := 1; i < len(list); i++ {
			add(list[i-1].writer, list[i].writer)
		}
	}
	for _, read := range reads {
		list := versions[read.key]
		if read.version >= 0 {
			add(list[read.version].writer, read.reader)
		}
		if read.version == -2 {
			continue
		}
		for i := read.version + 1; i < len(list); i++ {
			add(read.reader, list[i].writer)
		}
	}

	return oracleResult{cyclic: hasCycle(edges), wwConflict: wwConflict}
}

func sortedKeys(set map[string]struct{}) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func hasCycle(edges [][]bool) bool {
	const (
		unseen uint8 = iota
		visiting
		done
	)
	state := make([]uint8, len(edges))
	var visit func(int) bool
	visit = func(node int) bool {
		switch state[node] {
		case visiting:
			return true
		case done:
			return false
		}
		state[node] = visiting
		for next, present := range edges[node] {
			if present && visit(next) {
				return true
			}
		}
		state[node] = done
		return false
	}
	for node := range edges {
		if visit(node) {
			return true
		}
	}
	return false
}

type managedResult struct {
	victims map[int]struct{}
}

func runManagedSchedule(t *testing.T, programs [][]scheduleOp, schedule []scheduleOp) managedResult {
	t.Helper()
	m := NewManager()
	txs := make([]*Transaction, len(programs))
	owner := make(map[TxID]int)
	result := managedResult{victims: make(map[int]struct{})}

	recordVictim := func(id TxID) {
		if id == 0 {
			return
		}
		if program, ok := owner[id]; ok {
			result.victims[program] = struct{}{}
		}
	}

	for _, op := range schedule {
		switch op.kind {
		case opBegin:
			tx, err := m.Begin(TxOptions{ReadOnly: op.readOnly})
			if err != nil {
				t.Fatalf("begin: %v", err)
			}
			txs[op.tx] = tx
			owner[tx.ID] = op.tx
		case opRead:
			if tx := txs[op.tx]; tx != nil {
				_ = m.Read(tx, op.key)
			}
		case opWrite:
			if tx := txs[op.tx]; tx != nil {
				_ = m.Write(tx, op.key)
			}
		case opCommit:
			if tx := txs[op.tx]; tx != nil {
				decision := m.Commit(tx)
				if !decision.Committed {
					result.victims[op.tx] = struct{}{}
				}
				recordVictim(decision.Victim)
			}
		case opAbort:
			if tx := txs[op.tx]; tx != nil {
				_ = m.Abort(tx)
			}
		}
	}
	return result
}

type exhaustiveStats struct {
	schedules    int
	cycles       int
	victimized   int
	falseKills   int
	missed       int
	wwConflicts  int
	totalVictims int
}

func exhaustSchedules(t *testing.T, name string, programs [][]scheduleOp, maxFalseKills int) exhaustiveStats {
	t.Helper()
	var stats exhaustiveStats
	forEachInterleaving(programs, func(schedule []scheduleOp) {
		stats.schedules++
		oracle := simulateIntendedHistory(programs, schedule)
		managed := runManagedSchedule(t, programs, schedule)
		if oracle.cyclic {
			stats.cycles++
		}
		if oracle.wwConflict {
			stats.wwConflicts++
		}
		if len(managed.victims) != 0 {
			stats.victimized++
		}
		stats.totalVictims += len(managed.victims)
		missed := false
		if oracle.cyclic && len(managed.victims) == 0 {
			missed = true
			t.Logf("missed cycle: %v", schedule)
		}
		if oracle.wwConflict && len(managed.victims) == 0 {
			missed = true
			t.Logf("missed write-write conflict: %v", schedule)
		}
		if missed {
			stats.missed++
		}
		if !oracle.cyclic && !oracle.wwConflict && len(managed.victims) != 0 {
			stats.falseKills++
		}
	})

	t.Logf("%s: schedules=%d cycles=%d ww=%d victimized=%d false-kills=%d missed=%d",
		name, stats.schedules, stats.cycles, stats.wwConflicts, stats.victimized,
		stats.falseKills, stats.missed)
	if stats.missed != 0 {
		t.Fatalf("%s: %d missed serialization failures", name, stats.missed)
	}
	if stats.falseKills > maxFalseKills {
		t.Fatalf("%s: %d false kills exceeds limit %d", name, stats.falseKills, maxFalseKills)
	}
	return stats
}

func TestExhaustiveWriteSkew(t *testing.T) {
	programs := [][]scheduleOp{
		{
			{kind: opBegin, tx: 0},
			{kind: opRead, tx: 0, key: "a"},
			{kind: opWrite, tx: 0, key: "b"},
			{kind: opCommit, tx: 0},
		},
		{
			{kind: opBegin, tx: 1},
			{kind: opRead, tx: 1, key: "b"},
			{kind: opWrite, tx: 1, key: "a"},
			{kind: opCommit, tx: 1},
		},
	}
	stats := exhaustSchedules(t, "write-skew", programs, 0)
	if stats.cycles == 0 || stats.victimized == 0 {
		t.Fatal("oracle did not exercise write skew")
	}
}

func TestExhaustiveThreeTransactionCycle(t *testing.T) {
	programs := [][]scheduleOp{
		{
			{kind: opBegin, tx: 0},
			{kind: opRead, tx: 0, key: "a"},
			{kind: opWrite, tx: 0, key: "b"},
			{kind: opCommit, tx: 0},
		},
		{
			{kind: opBegin, tx: 1},
			{kind: opRead, tx: 1, key: "b"},
			{kind: opWrite, tx: 1, key: "c"},
			{kind: opCommit, tx: 1},
		},
		{
			{kind: opBegin, tx: 2},
			{kind: opRead, tx: 2, key: "c"},
			{kind: opWrite, tx: 2, key: "a"},
			{kind: opCommit, tx: 2},
		},
	}
	exhaustSchedules(t, "three-cycle", programs, 0)
}

func TestExhaustiveReadOnlyIsAlwaysSafe(t *testing.T) {
	programs := [][]scheduleOp{
		{
			{kind: opBegin, tx: 0, readOnly: true},
			{kind: opRead, tx: 0, key: "a"},
			{kind: opCommit, tx: 0},
		},
		{
			{kind: opBegin, tx: 1},
			{kind: opWrite, tx: 1, key: "a"},
			{kind: opCommit, tx: 1},
		},
	}
	exhaustSchedules(t, "read-only", programs, 0)
}

func TestExhaustiveWriteWriteConflict(t *testing.T) {
	programs := [][]scheduleOp{
		{
			{kind: opBegin, tx: 0},
			{kind: opWrite, tx: 0, key: "a"},
			{kind: opCommit, tx: 0},
		},
		{
			{kind: opBegin, tx: 1},
			{kind: opWrite, tx: 1, key: "a"},
			{kind: opCommit, tx: 1},
		},
	}
	stats := exhaustSchedules(t, "write-write", programs, 0)
	if stats.wwConflicts == 0 || stats.victimized == 0 {
		t.Fatal("oracle did not exercise write-write conflicts")
	}
}
