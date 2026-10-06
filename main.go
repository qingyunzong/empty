package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
)

const usageText = `差旅报价 CLI

用法:
  travelcli cover    -days 1-3,7 -tickets tickets.json [-verify] [-json]
  travelcli activate -days 1-3,7 -tickets tickets.json [-verify] [-json]

cover:    组合单程票/区间票/通票覆盖固定出行日,票种 <= 22,每票限购一次。
          车票 JSON: [{"id":"A","kind":"通票","price":100,"days":[1,2,3]}]
          目标序: 费用最小 → 票数最少 → ID 序列最小,输出覆盖证书。
activate: 车票乘车触发激活,激活后 validDays 天有效,最多使用 maxUses 天。
          车票 JSON: [{"id":"A","price":100,"validDays":3,"maxUses":2}]
          求购票与激活联合方案,输出逐日使用证书。

-days    出行日列表,支持逗号与区间,如 1-3,7
-tickets 车票 JSON 文件路径,"-" 表示标准输入
-verify  穷举核验(小规模):cover 枚举 2^n 子集;activate 枚举购票子集×激活分配
-json    以 JSON 输出证书
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout))
}

func run(args []string, out io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(out, usageText)
		return 2
	}
	var err error
	switch args[0] {
	case "cover":
		err = runCover(args[1:], out)
	case "activate":
		err = runActivate(args[1:], out)
	default:
		fmt.Fprint(out, usageText)
		return 2
	}
	if err != nil {
		fmt.Fprintln(out, "错误:", err)
		return 1
	}
	return 0
}

func parseDays(s string) ([]int, error) {
	if strings.TrimSpace(s) == "" {
		return nil, errors.New("必须指定 -days,如 1-3,7")
	}
	set := map[int]bool{}
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil, fmt.Errorf("非法的出行日描述: %q", s)
		}
		if strings.Contains(part, "-") {
			ab := strings.SplitN(part, "-", 2)
			a, err1 := strconv.Atoi(strings.TrimSpace(ab[0]))
			b, err2 := strconv.Atoi(strings.TrimSpace(ab[1]))
			if err1 != nil || err2 != nil || a > b {
				return nil, fmt.Errorf("非法的区间: %q", part)
			}
			for d := a; d <= b; d++ {
				set[d] = true
			}
		} else {
			v, err := strconv.Atoi(part)
			if err != nil {
				return nil, fmt.Errorf("非法的日期: %q", part)
			}
			set[v] = true
		}
	}
	days := make([]int, 0, len(set))
	for d := range set {
		days = append(days, d)
	}
	sort.Ints(days)
	return days, nil
}

func loadJSON(path string, v any) error {
	var data []byte
	var err error
	if path == "-" {
		data, err = io.ReadAll(os.Stdin)
	} else {
		data, err = os.ReadFile(path)
	}
	if err != nil {
		return fmt.Errorf("读取车票文件失败: %w", err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		return fmt.Errorf("解析车票 JSON 失败: %w", err)
	}
	return nil
}

func equalStrings(a, b []string) bool {
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

func sortedKeys(m map[int]string) []int {
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	return keys
}

func newFlagSet(name string, days, tickets *string, verify, asJSON *bool) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(days, "days", "", "出行日列表,如 1-3,7")
	fs.StringVar(tickets, "tickets", "", "车票 JSON 文件路径,'-' 表示标准输入")
	fs.BoolVar(verify, "verify", false, "穷举核验最优性")
	fs.BoolVar(asJSON, "json", false, "以 JSON 输出证书")
	return fs
}

func runCover(args []string, out io.Writer) error {
	var daysFlag, ticketsFlag string
	var verify, asJSON bool
	fs := newFlagSet("cover", &daysFlag, &ticketsFlag, &verify, &asJSON)
	if err := fs.Parse(args); err != nil {
		return err
	}
	days, err := parseDays(daysFlag)
	if err != nil {
		return err
	}
	var tickets []CoverTicket
	if err := loadJSON(ticketsFlag, &tickets); err != nil {
		return err
	}
	p := CoverProblem{Days: days, Tickets: tickets}
	cert, err := SolveCover(p)
	if err != nil {
		return err
	}
	if err := VerifyCover(p, cert); err != nil {
		return fmt.Errorf("证书自检失败: %w", err)
	}
	if asJSON {
		data, _ := json.MarshalIndent(cert, "", "  ")
		fmt.Fprintln(out, string(data))
	} else {
		fmt.Fprintf(out, "最小费用: %d (票数: %d)\n", cert.Cost, cert.Count)
		fmt.Fprintf(out, "购票: %s\n", strings.Join(cert.TicketIDs, ", "))
		fmt.Fprintln(out, "逐日覆盖证书:")
		for _, d := range sortedKeys(cert.DayCover) {
			fmt.Fprintf(out, "  第 %d 天 -> 车票 %s\n", d, cert.DayCover[d])
		}
	}
	if verify {
		bf, total, err := BruteForceCover(p)
		if err != nil {
			return err
		}
		if bf.Cost != cert.Cost || bf.Count != cert.Count || !equalStrings(bf.TicketIDs, cert.TicketIDs) {
			return fmt.Errorf("穷举核验失败: 求解器=(%d,%d,%v) 穷举=(%d,%d,%v)",
				cert.Cost, cert.Count, cert.TicketIDs, bf.Cost, bf.Count, bf.TicketIDs)
		}
		fmt.Fprintf(out, "穷举核验通过: 枚举 %d 个购票子集,最优解一致\n", total)
	}
	return nil
}

func runActivate(args []string, out io.Writer) error {
	var daysFlag, ticketsFlag string
	var verify, asJSON bool
	fs := newFlagSet("activate", &daysFlag, &ticketsFlag, &verify, &asJSON)
	if err := fs.Parse(args); err != nil {
		return err
	}
	days, err := parseDays(daysFlag)
	if err != nil {
		return err
	}
	var tickets []ActTicket
	if err := loadJSON(ticketsFlag, &tickets); err != nil {
		return err
	}
	p := ActProblem{Days: days, Tickets: tickets}
	cert, err := SolveActivate(p)
	if err != nil {
		return err
	}
	if err := VerifyActivate(p, cert); err != nil {
		return fmt.Errorf("证书自检失败: %w", err)
	}
	if asJSON {
		data, _ := json.MarshalIndent(cert, "", "  ")
		fmt.Fprintln(out, string(data))
	} else {
		fmt.Fprintf(out, "最小费用: %d (票数: %d)\n", cert.Cost, cert.Count)
		parts := make([]string, 0, len(cert.TicketIDs))
		for _, id := range cert.TicketIDs {
			parts = append(parts, fmt.Sprintf("%s(第 %d 天激活)", id, cert.ActivateOn[id]))
		}
		fmt.Fprintf(out, "购票: %s\n", strings.Join(parts, ", "))
		fmt.Fprintln(out, "逐日使用证书:")
		for _, d := range sortedKeys(cert.DayUse) {
			fmt.Fprintf(out, "  第 %d 天 -> 车票 %s\n", d, cert.DayUse[d])
		}
	}
	if verify {
		est := math.Pow(float64(len(p.Tickets))+1, float64(len(p.Days))) * math.Pow(2, float64(len(p.Tickets)))
		if est > 5e8 {
			return fmt.Errorf("规模过大,无法穷举核验(估计 %.2e 种方案);请缩短行程或减少票种", est)
		}
		bf, checked, err := BruteForceActivate(p)
		if err != nil {
			return err
		}
		if bf.Cost != cert.Cost || bf.Count != cert.Count || !equalStrings(bf.TicketIDs, cert.TicketIDs) {
			return fmt.Errorf("穷举核验失败: 求解器=(%d,%d,%v) 穷举=(%d,%d,%v)",
				cert.Cost, cert.Count, cert.TicketIDs, bf.Cost, bf.Count, bf.TicketIDs)
		}
		fmt.Fprintf(out, "穷举核验通过: 检查 %d 个购票×激活方案,最优解一致\n", checked)
	}
	return nil
}
