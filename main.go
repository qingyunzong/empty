// Command sched reads a simple script of scheduling commands and prints
// optimal unit-task schedules with a time certificate.
//
// Commands (one per line, '#' starts a comment):
//
//	add <id> <release> <deadline> <profit>   add a unit-duration task
//	remove <id>                              remove a task and recompute
//	undo [id]                                like remove; bare undo drops the last added task
//	list                                     list current tasks
//	solve                                    print optimal schedule + time certificate
//	verify                                   cross-check solve against brute force (n <= 12)
//	help                                     show this summary
package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"

	"sched/sched"
)

const bruteLimit = 12

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(in io.Reader, out io.Writer) error {
	var tasks []sched.Task
	scanner := bufio.NewScanner(in)
	for scanner.Scan() {
		line := scanner.Text()
		fields := tokenize(line)
		if len(fields) == 0 {
			continue
		}
		var err error
		switch fields[0] {
		case "add":
			tasks, err = cmdAdd(tasks, fields)
		case "remove":
			tasks, err = cmdRemove(tasks, fields)
		case "undo":
			tasks, err = cmdUndo(tasks, fields)
		case "list":
			cmdList(tasks, out)
		case "solve":
			err = cmdSolve(tasks, out)
		case "verify":
			err = cmdVerify(tasks, out)
		case "help":
			printUsage(out)
		default:
			err = fmt.Errorf("unknown command %q", fields[0])
		}
		if err != nil {
			return fmt.Errorf("%q: %w", line, err)
		}
	}
	return scanner.Err()
}

// tokenize splits a line into fields, stripping any '#' comment.
func tokenize(line string) []string {
	var fields []string
	for _, f := range splitFields(line) {
		if f[0] == '#' {
			break
		}
		fields = append(fields, f)
	}
	return fields
}

func splitFields(line string) []string {
	var out []string
	start := -1
	for i := 0; i <= len(line); i++ {
		if i < len(line) && line[i] != ' ' && line[i] != '\t' {
			if start < 0 {
				start = i
			}
		} else if start >= 0 {
			out = append(out, line[start:i])
			start = -1
		}
	}
	return out
}

func cmdAdd(tasks []sched.Task, fields []string) ([]sched.Task, error) {
	if len(fields) != 5 {
		return nil, fmt.Errorf("usage: add <id> <release> <deadline> <profit>")
	}
	var nums [4]int64
	for i, f := range fields[1:] {
		v, err := strconv.ParseInt(f, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("bad number %q", f)
		}
		nums[i] = v
	}
	task := sched.Task{
		ID:       int(nums[0]),
		Release:  int(nums[1]),
		Deadline: int(nums[2]),
		Profit:   nums[3],
	}
	for _, t := range tasks {
		if t.ID == task.ID {
			return nil, fmt.Errorf("duplicate task ID %d", task.ID)
		}
	}
	if len(tasks)+1 > sched.MaxTasks {
		return nil, fmt.Errorf("too many tasks: at most %d", sched.MaxTasks)
	}
	return append(tasks, task), nil
}

func cmdRemove(tasks []sched.Task, fields []string) ([]sched.Task, error) {
	if len(fields) != 2 {
		return nil, fmt.Errorf("usage: remove <id>")
	}
	id, err := strconv.Atoi(fields[1])
	if err != nil {
		return nil, fmt.Errorf("bad task ID %q", fields[1])
	}
	return removeByID(tasks, id)
}

func cmdUndo(tasks []sched.Task, fields []string) ([]sched.Task, error) {
	if len(tasks) == 0 {
		return nil, fmt.Errorf("nothing to undo")
	}
	if len(fields) == 1 {
		return tasks[:len(tasks)-1], nil
	}
	if len(fields) == 2 {
		id, err := strconv.Atoi(fields[1])
		if err != nil {
			return nil, fmt.Errorf("bad task ID %q", fields[1])
		}
		return removeByID(tasks, id)
	}
	return nil, fmt.Errorf("usage: undo [id]")
}

func removeByID(tasks []sched.Task, id int) ([]sched.Task, error) {
	for i, t := range tasks {
		if t.ID == id {
			return append(tasks[:i], tasks[i+1:]...), nil
		}
	}
	return nil, fmt.Errorf("no task with ID %d", id)
}

func cmdList(tasks []sched.Task, out io.Writer) {
	sorted := append([]sched.Task(nil), tasks...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })
	fmt.Fprintf(out, "%d task(s):\n", len(sorted))
	for _, t := range sorted {
		fmt.Fprintf(out, "  task %d: release=%d deadline=%d profit=%d\n",
			t.ID, t.Release, t.Deadline, t.Profit)
	}
}

func cmdSolve(tasks []sched.Task, out io.Writer) error {
	sol, err := sched.Solve(tasks)
	if err != nil {
		return err
	}
	printSolution(sol, out)
	return nil
}

func printSolution(sol sched.Solution, out io.Writer) {
	fmt.Fprintln(out, "== optimal schedule ==")
	fmt.Fprintf(out, "total profit: %d\n", sol.Profit)
	fmt.Fprintf(out, "tasks scheduled: %d\n", len(sol.Order))
	for _, id := range sol.Order {
		t := sol.Tasks[id]
		fmt.Fprintf(out, "  slot %d: task %d (release=%d deadline=%d profit=%d)\n",
			sol.Slots[id], id, t.Release, t.Deadline, t.Profit)
	}
	fmt.Fprintln(out, "== time certificate ==")
	if err := sol.Verify(); err != nil {
		fmt.Fprintf(out, "  INVALID: %v\n", err)
		return
	}
	fmt.Fprintf(out, "  ok: %d distinct slot(s), each within [release, deadline)\n", len(sol.Order))
	fmt.Fprintf(out, "  ok: execution order %v matches slot order\n", sol.Order)
	fmt.Fprintf(out, "  ok: certificate profit %d is optimal (exhaustive subset search)\n", sol.Profit)
}

func cmdVerify(tasks []sched.Task, out io.Writer) error {
	if len(tasks) > bruteLimit {
		return fmt.Errorf("verify needs at most %d tasks, have %d", bruteLimit, len(tasks))
	}
	sol, err := sched.Solve(tasks)
	if err != nil {
		return err
	}
	brute := sched.BruteForce(tasks)
	match := sol.Profit == brute.Profit && equalSeq(sol.Order, brute.Order)
	fmt.Fprintf(out, "solve : profit=%d order=%v\n", sol.Profit, sol.Order)
	fmt.Fprintf(out, "brute : profit=%d order=%v\n", brute.Profit, brute.Order)
	if !match {
		return fmt.Errorf("MISMATCH between solve and brute force")
	}
	fmt.Fprintln(out, "match: ok")
	return nil
}

func equalSeq(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func printUsage(out io.Writer) {
	fmt.Fprint(out, `commands:
  add <id> <release> <deadline> <profit>   add a unit-duration task
  remove <id>                              remove a task and recompute
  undo [id]                                remove by ID, or last added task
  list                                     list current tasks
  solve                                    print optimal schedule + time certificate
  verify                                   cross-check against brute force (n <= 12)
  help                                     show this summary
`)
}
