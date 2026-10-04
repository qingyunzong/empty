package main

import (
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

func TestKnownInstance(t *testing.T) {
	tasks := []Task{
		{ID: 1, Release: 0, Deadline: 2, Profit: 10},
		{ID: 2, Release: 0, Deadline: 1, Profit: 8},
		{ID: 3, Release: 1, Deadline: 3, Profit: 9},
	}
	res := Solve(tasks)
	if res.Profit != 27 {
		t.Fatalf("收益 = %d, 期望 27", res.Profit)
	}
	// 任务 1 若先执行占槽位 0，任务 2 将无处可放，故最小序列为 [2 1 3]。
	want := []int{2, 1, 3}
	if !reflect.DeepEqual(res.Sequence, want) {
		t.Fatalf("序列 = %v, 期望 %v", res.Sequence, want)
	}
	wantSlots := []Assignment{{TaskID: 2, Slot: 0}, {TaskID: 1, Slot: 1}, {TaskID: 3, Slot: 2}}
	if !reflect.DeepEqual(res.Slots, wantSlots) {
		t.Fatalf("槽位 = %v, 期望 %v", res.Slots, wantSlots)
	}
	if err := Verify(tasks, res); err != nil {
		t.Fatalf("证书校验失败: %v", err)
	}
}

func TestTieBreakSmallestID(t *testing.T) {
	// 两任务竞争同一槽位且收益相同，应选 ID 更小者。
	tasks := []Task{
		{ID: 5, Release: 0, Deadline: 1, Profit: 7},
		{ID: 2, Release: 0, Deadline: 1, Profit: 7},
	}
	res := Solve(tasks)
	if res.Profit != 7 || !reflect.DeepEqual(res.Sequence, []int{2}) {
		t.Fatalf("got %+v, 期望收益 7 序列 [2]", res)
	}
}

func TestReleaseForcesIdle(t *testing.T) {
	tasks := []Task{
		{ID: 1, Release: 5, Deadline: 7, Profit: 10},
		{ID: 2, Release: 0, Deadline: 1, Profit: 10},
	}
	res := Solve(tasks)
	if res.Profit != 20 || !reflect.DeepEqual(res.Sequence, []int{2, 1}) {
		t.Fatalf("got %+v", res)
	}
	wantSlots := []Assignment{{TaskID: 2, Slot: 0}, {TaskID: 1, Slot: 5}}
	if !reflect.DeepEqual(res.Slots, wantSlots) {
		t.Fatalf("槽位 = %v, 期望 %v", res.Slots, wantSlots)
	}
}

func TestUnschedulableTask(t *testing.T) {
	tasks := []Task{{ID: 1, Release: 3, Deadline: 3, Profit: 100}}
	res := Solve(tasks)
	if res.Profit != 0 || len(res.Sequence) != 0 {
		t.Fatalf("got %+v, 期望空结果", res)
	}
}

func TestRemoveAndRecompute(t *testing.T) {
	s := NewScheduler()
	all := []Task{
		{ID: 1, Release: 0, Deadline: 2, Profit: 10},
		{ID: 2, Release: 0, Deadline: 1, Profit: 8},
		{ID: 3, Release: 1, Deadline: 3, Profit: 9},
	}
	for _, task := range all {
		if err := s.Add(task); err != nil {
			t.Fatal(err)
		}
	}
	before := s.Solve()
	if before.Profit != 27 {
		t.Fatalf("撤销前收益 = %d, 期望 27", before.Profit)
	}
	if err := s.Remove(2); err != nil {
		t.Fatal(err)
	}
	after := s.Solve()
	fresh := Solve([]Task{all[0], all[2]})
	if !reflect.DeepEqual(after, fresh) {
		t.Fatalf("撤销后重算 %+v 与新实例 %+v 不一致", after, fresh)
	}
	if after.Profit != 19 {
		t.Fatalf("撤销后收益 = %d, 期望 19", after.Profit)
	}
	if err := s.Remove(99); err == nil {
		t.Fatal("撤销不存在的任务应报错")
	}
}

func TestVerifyRejectsTampering(t *testing.T) {
	tasks := []Task{
		{ID: 1, Release: 0, Deadline: 2, Profit: 10},
		{ID: 2, Release: 0, Deadline: 1, Profit: 8},
	}
	res := Solve(tasks)
	if err := Verify(tasks, res); err != nil {
		t.Fatalf("合法证书应通过: %v", err)
	}
	bad := res
	bad.Slots = append([]Assignment(nil), res.Slots...)
	bad.Slots[0].Slot = 5 // 超出截止
	if err := Verify(tasks, bad); err == nil {
		t.Fatal("篡改槽位应校验失败")
	}
	bad2 := res
	bad2.Profit++
	if err := Verify(tasks, bad2); err == nil {
		t.Fatal("篡改收益应校验失败")
	}
	bad3 := res
	bad3.Slots = append([]Assignment(nil), res.Slots...)
	bad3.Slots[1].Slot = bad3.Slots[0].Slot // 槽位冲突
	if err := Verify(tasks, bad3); err == nil {
		t.Fatal("槽位冲突应校验失败")
	}
}

// TestSolveMatchesBruteForce 随机小实例上对照 Solve 与穷举所有序列的 BruteForce。
func TestSolveMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 500; trial++ {
		n := 1 + rng.Intn(8)
		tasks := make([]Task, n)
		for i := range tasks {
			r := rng.Intn(6)
			d := r + rng.Intn(8) // 允许 d<=r（不可调度任务）
			tasks[i] = Task{ID: i, Release: r, Deadline: d, Profit: 1 + rng.Intn(20)}
		}
		fast := Solve(tasks)
		slow := BruteForce(tasks)
		if fast.Profit != slow.Profit {
			t.Fatalf("trial %d tasks=%v: 收益 %d != 穷举 %d", trial, tasks, fast.Profit, slow.Profit)
		}
		if !reflect.DeepEqual(fast.Sequence, slow.Sequence) {
			t.Fatalf("trial %d tasks=%v: 序列 %v != 穷举 %v", trial, tasks, fast.Sequence, slow.Sequence)
		}
		if !reflect.DeepEqual(fast.Slots, slow.Slots) {
			t.Fatalf("trial %d tasks=%v: 槽位 %v != 穷举 %v", trial, tasks, fast.Slots, slow.Slots)
		}
		if err := Verify(tasks, fast); err != nil {
			t.Fatalf("trial %d: 证书校验失败: %v", trial, err)
		}
	}
}

func TestMaxSizeInstance(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	tasks := make([]Task, 18)
	for i := range tasks {
		r := rng.Intn(10)
		tasks[i] = Task{ID: i, Release: r, Deadline: r + 1 + rng.Intn(12), Profit: 1 + rng.Intn(50)}
	}
	res := Solve(tasks)
	if err := Verify(tasks, res); err != nil {
		t.Fatalf("18 任务证书校验失败: %v", err)
	}
}

func TestCLI(t *testing.T) {
	script := strings.Join([]string{
		"add 1 0 2 10",
		"add 2 0 1 8",
		"add 3 1 3 9",
		"solve",
		"verify",
		"remove 2",
		"solve",
		"brute",
		"list",
		"quit",
	}, "\n")
	var out strings.Builder
	run(strings.NewReader(script), &out)
	got := out.String()
	for _, want := range []string{
		"最优总收益: 27",
		"执行序列: 2 1 3",
		"槽位 0 -> 任务 2",
		"证书校验通过",
		"已撤销任务 2",
		"最优总收益: 19",
		"对照结果: 一致",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("CLI 输出缺少 %q\n完整输出:\n%s", want, got)
		}
	}
}
