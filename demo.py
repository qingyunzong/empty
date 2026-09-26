"""运行样例：python3 demo.py"""

from alldiff import (
    brute_force_solution,
    exhaustive_supported_values,
    filter_domains,
    find_matching,
    validate_assignment,
)


def show(title, domains):
    print(f"== {title} ==")
    print("域:", [sorted(d) for d in domains])
    result = filter_domains(domains)
    if result.feasible:
        print("过滤后域:", [sorted(d) for d in result.domains])
        print("匹配解:", result.matching)
        ok = validate_assignment(domains, result.matching)
        independent = brute_force_solution(domains)
        print(f"独立检查器验证匹配解: {ok}; 独立穷举解: {independent}")
    else:
        c = result.conflict
        print(f"不可行。Hall 冲突集: 变量 {list(c.variables)}, "
              f"邻域值 {list(c.neighborhood)}, 缺口 {c.deficit}")
        print(f"独立穷举确认无解: {brute_force_solution(domains) is None}")
    print()


def main():
    show("样例1: 三个变量仅域 {1,2}（不可行）", [{1, 2}, {1, 2}, {1, 2}])

    show("样例2: 已固定值从其他域移除", [{1}, {1, 2, 3}, {2, 3}])

    show("样例3: 无已赋值变量仍需过滤（两两检查做不到）",
         [{1, 2}, {1, 2}, {1, 2, 3}])

    show("样例4: 一般可行实例", [{1, 2}, {2, 3}, {1, 3}, {3, 4}])

    domains = [{1, 2}, {2, 3}, {1, 3}]
    print("== 样例5: 支持过滤 vs 穷举支持集 ==")
    print("域:", [sorted(d) for d in domains])
    result = filter_domains(domains)
    print("过滤后域:      ", [sorted(d) for d in result.domains])
    print("穷举支持集:    ", [sorted(s) for s in exhaustive_supported_values(domains)])


if __name__ == "__main__":
    main()
