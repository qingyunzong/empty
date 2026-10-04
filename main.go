package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

const helpText = `命令:
  add <id> <release> <deadline> <profit>  添加单位时长任务
  remove <id>                             撤销任务（之后可重新 solve）
  list                                    列出当前任务
  solve                                   求最大总收益集合及时间证书
  brute                                   穷举所有序列对照（建议 n<=12）
  verify                                  校验最近一次 solve 的时间证书
  clear                                   清空任务
  help                                    显示帮助
  quit                                    退出`

func printResult(w io.Writer, res Result) {
	fmt.Fprintf(w, "最优总收益: %d\n", res.Profit)
	if len(res.Sequence) == 0 {
		fmt.Fprintln(w, "执行序列: (空)")
		return
	}
	ids := make([]string, len(res.Sequence))
	for i, id := range res.Sequence {
		ids[i] = strconv.Itoa(id)
	}
	fmt.Fprintf(w, "执行序列: %s\n", strings.Join(ids, " "))
	fmt.Fprintln(w, "时间证书:")
	for _, a := range res.Slots {
		fmt.Fprintf(w, "  槽位 %d -> 任务 %d\n", a.Slot, a.TaskID)
	}
}

// handleLine 处理一行命令，返回 false 表示退出。
func handleLine(s *Scheduler, last *Result, line string, w io.Writer) bool {
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return true
	}
	switch fields[0] {
	case "add":
		if len(fields) != 5 {
			fmt.Fprintln(w, "用法: add <id> <release> <deadline> <profit>")
			return true
		}
		var nums [4]int
		for i := 0; i < 4; i++ {
			v, err := strconv.Atoi(fields[i+1])
			if err != nil {
				fmt.Fprintf(w, "参数 %q 不是整数\n", fields[i+1])
				return true
			}
			nums[i] = v
		}
		t := Task{ID: nums[0], Release: nums[1], Deadline: nums[2], Profit: nums[3]}
		if t.Deadline <= t.Release {
			fmt.Fprintf(w, "警告: 任务 %d 截止不晚于释放，永远无法调度\n", t.ID)
		}
		if err := s.Add(t); err != nil {
			fmt.Fprintln(w, "错误:", err)
			return true
		}
		fmt.Fprintf(w, "已添加任务 %d\n", t.ID)
	case "remove":
		if len(fields) != 2 {
			fmt.Fprintln(w, "用法: remove <id>")
			return true
		}
		id, err := strconv.Atoi(fields[1])
		if err != nil {
			fmt.Fprintf(w, "参数 %q 不是整数\n", fields[1])
			return true
		}
		if err := s.Remove(id); err != nil {
			fmt.Fprintln(w, "错误:", err)
			return true
		}
		fmt.Fprintf(w, "已撤销任务 %d\n", id)
	case "list":
		tasks := s.Tasks()
		if len(tasks) == 0 {
			fmt.Fprintln(w, "(无任务)")
			return true
		}
		for _, t := range tasks {
			fmt.Fprintf(w, "任务 %d: 释放 %d, 截止 %d, 收益 %d\n", t.ID, t.Release, t.Deadline, t.Profit)
		}
	case "solve":
		res := s.Solve()
		*last = res
		printResult(w, res)
	case "brute":
		if s.Len() > 12 {
			fmt.Fprintf(w, "任务数 %d 过多，穷举对照限 n<=12\n", s.Len())
			return true
		}
		fast := s.Solve()
		slow := BruteForce(s.Tasks())
		fmt.Fprintln(w, "[solve]")
		printResult(w, fast)
		fmt.Fprintln(w, "[brute]")
		printResult(w, slow)
		if fast.Profit == slow.Profit && seqEqual(fast.Sequence, slow.Sequence) {
			fmt.Fprintln(w, "对照结果: 一致")
		} else {
			fmt.Fprintln(w, "对照结果: 不一致!")
		}
	case "verify":
		if last.Sequence == nil {
			fmt.Fprintln(w, "尚未 solve")
			return true
		}
		if err := Verify(s.Tasks(), *last); err != nil {
			fmt.Fprintln(w, "证书校验失败:", err)
		} else {
			fmt.Fprintln(w, "证书校验通过")
		}
	case "clear":
		s.tasks = make(map[int]Task)
		fmt.Fprintln(w, "已清空")
	case "help":
		fmt.Fprintln(w, helpText)
	case "quit", "exit":
		return false
	default:
		fmt.Fprintf(w, "未知命令 %q，输入 help 查看帮助\n", fields[0])
	}
	return true
}

func seqEqual(a, b []int) bool {
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

func run(in io.Reader, w io.Writer) {
	s := NewScheduler()
	last := &Result{}
	sc := bufio.NewScanner(in)
	fmt.Fprintln(w, "单位时长任务调度器（n<=18）。输入 help 查看命令。")
	for sc.Scan() {
		if !handleLine(s, last, sc.Text(), w) {
			return
		}
	}
}

func main() {
	run(os.Stdin, os.Stdout)
}
