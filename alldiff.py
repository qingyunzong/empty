"""allDifferent 约束：基于二分匹配的可行性检查与支持过滤（Régin 算法）。

- Hopcroft-Karp 求变量-值二分图最大匹配，判定可行性。
- 不可行时，从自由变量点沿交错路可达的变量集给出 Hall 冲突集 S（|N(S)| < |S|）。
- 可行时，对匹配边/非匹配边定向后求强连通分量，过滤不出现在任何
  最大匹配中的值（支持过滤），保持全部解。
另附独立穷举检查器，用于交叉验证（不依赖匹配算法）。
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass


@dataclass(frozen=True)
class HallConflict:
    """Hall 冲突：变量集 variables 的邻域只有 neighborhood 这些值，|S| > |N(S)|。"""

    variables: tuple
    neighborhood: tuple

    @property
    def deficit(self) -> int:
        return len(self.variables) - len(self.neighborhood)


@dataclass(frozen=True)
class FilterResult:
    feasible: bool
    domains: tuple | None = None
    matching: tuple | None = None
    conflict: HallConflict | None = None


def _hopcroft_karp(domains):
    """返回 (match_var, match_val)。match_var[x] 为变量 x 匹配到的值或 None。"""
    n = len(domains)
    match_var = [None] * n
    match_val = {}

    def bfs():
        dist = {}
        queue = deque()
        for x in range(n):
            if match_var[x] is None:
                dist[x] = 0
                queue.append(x)
        found_augmenting_end = False
        while queue:
            x = queue.popleft()
            for v in domains[x]:
                y = match_val.get(v)
                if y is None:
                    found_augmenting_end = True
                elif y not in dist:
                    dist[y] = dist[x] + 1
                    queue.append(y)
        return dist if found_augmenting_end else None

    def dfs(x, dist):
        for v in domains[x]:
            y = match_val.get(v)
            if y is None or (dist.get(y) == dist[x] + 1 and dfs(y, dist)):
                match_var[x] = v
                match_val[v] = x
                return True
        dist.pop(x, None)
        return False

    while True:
        dist = bfs()
        if dist is None:
            break
        for x in range(n):
            if match_var[x] is None:
                dfs(x, dist)
    return match_var, match_val


def _hall_conflict(domains, match_var, match_val):
    """从自由变量出发沿交错路（非匹配边 变量->值，匹配边 值->变量）求可达集。"""
    seen_vars = set()
    seen_vals = set()
    stack = [x for x in range(len(domains)) if match_var[x] is None]
    seen_vars.update(stack)
    while stack:
        x = stack.pop()
        for v in domains[x]:
            if match_var[x] == v or v in seen_vals:
                continue
            seen_vals.add(v)
            y = match_val.get(v)
            if y is not None and y not in seen_vars:
                seen_vars.add(y)
                stack.append(y)
    return HallConflict(tuple(sorted(seen_vars)), tuple(sorted(seen_vals)))


def find_matching(domains):
    """可行性检查。返回 (matching, conflict)，二者恰有一个非 None。

    matching[x] 是变量 x 分到的值；conflict 是 Hall 冲突集证据。
    """
    domains = [set(d) for d in domains]
    match_var, match_val = _hopcroft_karp(domains)
    if all(v is not None for v in match_var):
        return tuple(match_var), None
    return None, _hall_conflict(domains, match_var, match_val)


def _tarjan_scc(adj):
    index_of = {}
    low = {}
    on_stack = set()
    stack = []
    comp = {}
    counter = 0
    for root in range(len(adj)):
        if root in index_of:
            continue
        index_of[root] = low[root] = counter
        counter += 1
        stack.append(root)
        on_stack.add(root)
        work = [(root, iter(adj[root]))]
        while work:
            node, it = work[-1]
            descended = False
            for nxt in it:
                if nxt not in index_of:
                    index_of[nxt] = low[nxt] = counter
                    counter += 1
                    stack.append(nxt)
                    on_stack.add(nxt)
                    work.append((nxt, iter(adj[nxt])))
                    descended = True
                    break
                if nxt in on_stack:
                    low[node] = min(low[node], index_of[nxt])
            if descended:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index_of[node]:
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    comp[w] = node
                    if w == node:
                        break
    return comp


def filter_domains(domains):
    """支持过滤（Régin）：删除不出现在任何最大匹配中的值。

    返回 FilterResult：
    - feasible=True：domains 为过滤后的域（保持全部解），matching 为一个具体匹配；
    - feasible=False：conflict 为 Hall 冲突集证据。
    """
    domains = [set(d) for d in domains]
    n = len(domains)
    match_var, match_val = _hopcroft_karp(domains)
    if any(v is None for v in match_var):
        return FilterResult(
            feasible=False, conflict=_hall_conflict(domains, match_var, match_val)
        )

    values = sorted({v for d in domains for v in d})
    vidx = {v: i for i, v in enumerate(values)}
    adj = [[] for _ in range(n + len(values))]
    for x in range(n):
        for v in domains[x]:
            vnode = n + vidx[v]
            if match_var[x] == v:
                adj[vnode].append(x)
            else:
                adj[x].append(vnode)
    comp = _tarjan_scc(adj)

    # Berge 定理：非匹配边 (x,v) 属于某个最大匹配，当且仅当它在交错环上
    # （两端点同 SCC），或在从自由值点出发的交错路上（v 在定向图中可达某个
    # 未匹配的值点）。反向 BFS 求出所有能到达自由值点的节点。
    free_values = {v for v in values if v not in match_val}
    reaches_free = set()
    queue = deque(n + vidx[v] for v in free_values)
    reaches_free.update(queue)
    radj = [[] for _ in range(n + len(values))]
    for a in range(n + len(values)):
        for b in adj[a]:
            radj[b].append(a)
    while queue:
        node = queue.popleft()
        for prev in radj[node]:
            if prev not in reaches_free:
                reaches_free.add(prev)
                queue.append(prev)

    filtered = []
    for x in range(n):
        keep = {match_var[x]}
        for v in domains[x]:
            if comp[x] == comp[n + vidx[v]] or (n + vidx[v]) in reaches_free:
                keep.add(v)
        filtered.append(frozenset(keep))
    return FilterResult(
        feasible=True, domains=tuple(filtered), matching=tuple(match_var)
    )


# ---------- 独立检查器（穷举，不依赖匹配算法，用于交叉验证） ----------


def validate_assignment(domains, assignment):
    """对照原始约束独立验证一个赋值：属于原域且两两不同。"""
    if len(assignment) != len(domains):
        return False
    if any(assignment[x] not in domains[x] for x in range(len(domains))):
        return False
    return len(set(assignment)) == len(assignment)


def brute_force_solution(domains):
    """独立穷举求解器：回溯搜索，返回一个解或 None。"""
    domains = [set(d) for d in domains]
    order = sorted(range(len(domains)), key=lambda x: len(domains[x]))
    assignment = [None] * len(domains)
    used = set()

    def backtrack(i):
        if i == len(order):
            return True
        x = order[i]
        for v in domains[x]:
            if v in used:
                continue
            used.add(v)
            assignment[x] = v
            if backtrack(i + 1):
                return True
            used.discard(v)
            assignment[x] = None
        return False

    return tuple(assignment) if backtrack(0) else None


def exhaustive_supported_values(domains):
    """独立穷举支持集：逐值固定后回溯判定，返回每个变量真正可取的值集。"""
    result = []
    for x in range(len(domains)):
        supported = set()
        for v in domains[x]:
            narrowed = [set(d) for d in domains]
            narrowed[x] = {v}
            if brute_force_solution(narrowed) is not None:
                supported.add(v)
        result.append(supported)
    return result
