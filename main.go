package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

func main() {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "读取输入失败:", err)
		os.Exit(1)
	}
	ops, err := Parse(string(data))
	if err != nil {
		fmt.Fprintln(os.Stderr, "解析失败:", err)
		os.Exit(1)
	}
	ids := TxnIDs(ops)
	edges := BuildEdges(ops)

	fmt.Printf("事务 (%d 个): %s\n", len(ids), joinIDs(ids))
	fmt.Printf("操作 (%d 个): ", len(ops))
	for i, op := range ops {
		if i > 0 {
			fmt.Print(" ")
		}
		fmt.Printf("%c%d(%s)#%d", op.Kind, op.Txn, op.Item, i)
	}
	fmt.Println()

	fmt.Printf("冲突边 (%d 条):\n", len(edges))
	for _, e := range edges {
		fmt.Println("  " + e.String())
	}

	if cyc := FindCycle(ids, edges); cyc != nil {
		fmt.Println("结论: 不可串行化（依赖图有环）")
		fmt.Println("环上的具体读写冲突边:")
		for _, e := range cyc {
			fmt.Println("  " + e.String())
		}
		var path []string
		for _, e := range cyc {
			path = append(path, fmt.Sprintf("T%d", e.From))
		}
		path = append(path, fmt.Sprintf("T%d", cyc[len(cyc)-1].To))
		fmt.Println("环: " + strings.Join(path, " -> "))
		if len(ids) <= 8 {
			if valid := EnumerateValidOrders(ids, ops); len(valid) > 0 {
				fmt.Printf("备注: 冲突图有环，但枚举发现 %d 个视图等效串行顺序（视图可串行化）: ", len(valid))
				for i, v := range valid {
					if i > 0 {
						fmt.Print(", ")
					}
					fmt.Print(joinIDs(v))
				}
				fmt.Println()
			}
		}
		os.Exit(0)
	}

	order, _ := TopoMinID(ids, edges)
	fmt.Println("结论: 可串行化（依赖图无环）")
	fmt.Println("拓扑序（每轮取当前可执行事务中 ID 最小者）:")
	for round, id := range order {
		fmt.Printf("  第 %d 轮: T%d\n", round+1, id)
	}
	fmt.Printf("等效串行顺序: %s\n", joinIDs(order))

	if ReplayEquivalent(ops, order) {
		fmt.Println("独立重放验证: 通过（所有读操作版本与原调度一致）")
	} else {
		fmt.Println("独立重放验证: 失败（读版本不一致）")
		os.Exit(1)
	}
}

func joinIDs(ids []int) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = fmt.Sprintf("T%d", id)
	}
	return strings.Join(parts, " ")
}
