package main

import (
	"fmt"
	"sort"
)

// Task 是一个单位时长任务：占用恰好一个整数时间槽 [slot, slot+1)，
// 要求 Release <= slot < Deadline。
type Task struct {
	ID       int
	Release  int
	Deadline int
	Profit   int
}

// Assignment 是时间证书中的一项：任务 TaskID 在槽位 Slot 执行。
type Assignment struct {
	TaskID int
	Slot   int
}

// Result 是一次求解的结果，本身即时间证书。
type Result struct {
	Profit   int          // 最优总收益
	Sequence []int        // 任务 ID 的执行顺序（按时间先后）
	Slots    []Assignment // 每个任务的具体槽位，与 Sequence 一一对应
}

// Scheduler 维护当前任务集合，支持撤销（删除）后重算。
type Scheduler struct {
	tasks map[int]Task
}

func NewScheduler() *Scheduler {
	return &Scheduler{tasks: make(map[int]Task)}
}

func (s *Scheduler) Add(t Task) error {
	if t.ID < 0 {
		return fmt.Errorf("任务 ID 不能为负: %d", t.ID)
	}
	if _, ok := s.tasks[t.ID]; ok {
		return fmt.Errorf("任务 %d 已存在", t.ID)
	}
	s.tasks[t.ID] = t
	return nil
}

// Remove 撤销一个任务，之后可重新 Solve。
func (s *Scheduler) Remove(id int) error {
	if _, ok := s.tasks[id]; !ok {
		return fmt.Errorf("任务 %d 不存在", id)
	}
	delete(s.tasks, id)
	return nil
}

func (s *Scheduler) Tasks() []Task {
	out := make([]Task, 0, len(s.tasks))
	for _, t := range s.tasks {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (s *Scheduler) Len() int { return len(s.tasks) }

func (s *Scheduler) Solve() Result { return Solve(s.Tasks()) }

// clamp 把截止时刻收紧到 maxRelease+n：任何可行调度使用的槽位都不超过
// maxRelease+n-1（最早槽位贪心至多被推迟 n 次），因此收紧不改变可行性与收益。
func clamp(tasks []Task) ([]Task, int) {
	n := len(tasks)
	maxRel := 0
	for _, t := range tasks {
		if t.Release > maxRel {
			maxRel = t.Release
		}
	}
	cap := maxRel + n
	out := make([]Task, n)
	h := 0
	for i, t := range tasks {
		if t.Deadline > cap {
			t.Deadline = cap
		}
		out[i] = t
		if t.Deadline > h {
			h = t.Deadline
		}
	}
	return out, h
}

// feasibleSet 判断 jobs 能否全部安排在 >= lo 且未被 occupied 占用的槽位中。
// 单位时长任务下按截止时刻升序、每个任务取最早可用槽位的贪心是正确的。
// 注意：会修改 occupied（调用方负责保存/恢复）。
func feasibleSet(jobs []Task, occupied []bool, lo int) bool {
	js := make([]Task, len(jobs))
	copy(js, jobs)
	sort.Slice(js, func(a, b int) bool {
		if js[a].Deadline != js[b].Deadline {
			return js[a].Deadline < js[b].Deadline
		}
		return js[a].ID < js[b].ID
	})
	for _, j := range js {
		s := j.Release
		if s < lo {
			s = lo
		}
		for s < len(occupied) && occupied[s] {
			s++
		}
		if s >= j.Deadline {
			return false
		}
		occupied[s] = true
	}
	return true
}

// minSequence 为一个可行任务集合求字典序最小的执行序列（按任务 ID 比较），
// 同时给出对应的槽位分配。贪心：每一步按 ID 升序尝试候选任务，
// 取第一个放在最早可用槽位后、剩余任务仍可在更晚槽位完成的候选。
func minSequence(jobs []Task, h int) ([]int, []Assignment) {
	remaining := make([]Task, len(jobs))
	copy(remaining, jobs)
	occupied := make([]bool, h)
	lo := 0
	seq := make([]int, 0, len(jobs))
	var assigns []Assignment
	for len(remaining) > 0 {
		sort.Slice(remaining, func(a, b int) bool { return remaining[a].ID < remaining[b].ID })
		placed := false
		for i, j := range remaining {
			s := j.Release
			if s < lo {
				s = lo
			}
			for s < h && occupied[s] {
				s++
			}
			if s >= j.Deadline {
				continue
			}
			occupied[s] = true
			rest := make([]Task, 0, len(remaining)-1)
			rest = append(rest, remaining[:i]...)
			rest = append(rest, remaining[i+1:]...)
			trial := append([]bool(nil), occupied...)
			if feasibleSet(rest, trial, s+1) {
				seq = append(seq, j.ID)
				assigns = append(assigns, Assignment{TaskID: j.ID, Slot: s})
				lo = s + 1
				remaining = rest
				placed = true
				break
			}
			occupied[s] = false
		}
		if !placed {
			return nil, nil // 对可行集合不会发生
		}
	}
	return seq, assigns
}

// seqLess 按字典序比较两个执行序列，前缀较短者更小。
func seqLess(a, b []int) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

// Solve 枚举所有子集（n<=18，2^18=262144），找出总收益最大的可行子集；
// 收益并列时取任务 ID 执行序列字典序最小者。
func Solve(tasks []Task) Result {
	if len(tasks) == 0 {
		return Result{Profit: 0, Sequence: []int{}}
	}
	cl, h := clamp(tasks)
	n := len(cl)
	best := Result{Profit: 0, Sequence: []int{}}
	for mask := 1; mask < (1 << n); mask++ {
		profit := 0
		var jobs []Task
		for i := 0; i < n; i++ {
			if mask>>i&1 == 1 {
				profit += cl[i].Profit
				jobs = append(jobs, cl[i])
			}
		}
		if profit < best.Profit {
			continue
		}
		occupied := make([]bool, h)
		if !feasibleSet(jobs, occupied, 0) {
			continue
		}
		seq, slots := minSequence(jobs, h)
		if profit > best.Profit || seqLess(seq, best.Sequence) {
			best = Result{Profit: profit, Sequence: seq, Slots: slots}
		}
	}
	return best
}

// orderedAssign 检查一个给定顺序的排列是否可行（槽位严格递增），
// 可行时返回每个任务的槽位。
func orderedAssign(perm []Task) ([]Assignment, bool) {
	t := 0
	assigns := make([]Assignment, 0, len(perm))
	for _, j := range perm {
		s := j.Release
		if s < t {
			s = t
		}
		if s >= j.Deadline {
			return nil, false
		}
		assigns = append(assigns, Assignment{TaskID: j.ID, Slot: s})
		t = s + 1
	}
	return assigns, true
}

// BruteForce 穷举所有子集的所有排列，与 Solve 使用完全相同的比较规则，
// 用于小实例对照验证。
func BruteForce(tasks []Task) Result {
	if len(tasks) == 0 {
		return Result{Profit: 0, Sequence: []int{}}
	}
	cl, _ := clamp(tasks)
	n := len(cl)
	best := Result{Profit: 0, Sequence: []int{}}
	for mask := 1; mask < (1 << n); mask++ {
		profit := 0
		var jobs []Task
		for i := 0; i < n; i++ {
			if mask>>i&1 == 1 {
				profit += cl[i].Profit
				jobs = append(jobs, cl[i])
			}
		}
		if profit < best.Profit {
			continue
		}
		var visit func(k int)
		visit = func(k int) {
			if k == len(jobs) {
				assigns, ok := orderedAssign(jobs)
				if !ok {
					return
				}
				seq := make([]int, len(jobs))
				for i, j := range jobs {
					seq[i] = j.ID
				}
				if profit > best.Profit || seqLess(seq, best.Sequence) {
					best = Result{Profit: profit, Sequence: seq, Slots: assigns}
				}
				return
			}
			for i := k; i < len(jobs); i++ {
				jobs[k], jobs[i] = jobs[i], jobs[k]
				visit(k + 1)
				jobs[k], jobs[i] = jobs[i], jobs[k]
			}
		}
		visit(0)
	}
	return best
}

// Verify 校验时间证书：任务存在、槽位在 [Release, Deadline) 内、
// 槽位互不冲突且递增、序列与槽位一致、收益加总正确。
func Verify(tasks []Task, res Result) error {
	if len(res.Sequence) != len(res.Slots) {
		return fmt.Errorf("序列长度 %d 与槽位数 %d 不一致", len(res.Sequence), len(res.Slots))
	}
	byID := make(map[int]Task, len(tasks))
	for _, t := range tasks {
		byID[t.ID] = t
	}
	seenSlot := make(map[int]bool)
	seenTask := make(map[int]bool)
	profit := 0
	prev := -1
	for i, a := range res.Slots {
		t, ok := byID[a.TaskID]
		if !ok {
			return fmt.Errorf("证书包含未知任务 %d", a.TaskID)
		}
		if seenTask[a.TaskID] {
			return fmt.Errorf("任务 %d 被重复调度", a.TaskID)
		}
		seenTask[a.TaskID] = true
		if a.Slot < t.Release || a.Slot >= t.Deadline {
			return fmt.Errorf("任务 %d 槽位 %d 不在 [%d, %d) 内", a.TaskID, a.Slot, t.Release, t.Deadline)
		}
		if seenSlot[a.Slot] {
			return fmt.Errorf("槽位 %d 被重复占用", a.Slot)
		}
		seenSlot[a.Slot] = true
		if a.Slot <= prev {
			return fmt.Errorf("槽位未按时间递增（槽位 %d 出现在 %d 之后）", a.Slot, prev)
		}
		prev = a.Slot
		if res.Sequence[i] != a.TaskID {
			return fmt.Errorf("位置 %d 序列任务 %d 与槽位任务 %d 不一致", i, res.Sequence[i], a.TaskID)
		}
		profit += t.Profit
	}
	if profit != res.Profit {
		return fmt.Errorf("收益不符：证书加总 %d，声明 %d", profit, res.Profit)
	}
	return nil
}
