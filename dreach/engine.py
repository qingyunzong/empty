class UnknownSavepointError(Exception):
    """Raised when rollback refers to a savepoint that does not exist."""


class Engine:
    def __init__(self):
        self._n = None
        self._edges = set()
        self._snapshots = {}
        self._next_savepoint = 1

    def init(self, n):
        self._validate_count(n)
        self._n = n
        self._edges = set()
        self._snapshots = {}
        self._next_savepoint = 1

    def insert(self, u, v):
        self._require_initialized()
        self._validate_node(u, "u")
        self._validate_node(v, "v")
        self._edges.add((u, v))

    def delete(self, u, v):
        self._require_initialized()
        self._validate_node(u, "u")
        self._validate_node(v, "v")
        self._edges.discard((u, v))

    def savepoint(self):
        self._require_initialized()
        savepoint_id = self._next_savepoint
        self._next_savepoint += 1
        self._snapshots[savepoint_id] = (self._n, set(self._edges))
        return savepoint_id

    def rollback(self, savepoint_id):
        self._require_initialized()
        if not isinstance(savepoint_id, int) or isinstance(savepoint_id, bool):
            raise TypeError("savepoint must be an integer")
        if savepoint_id not in self._snapshots:
            raise UnknownSavepointError(f"unknown savepoint: {savepoint_id}")

        n, edges = self._snapshots[savepoint_id]
        self._n = n
        self._edges = set(edges)
        for stale_id in [sid for sid in self._snapshots if sid > savepoint_id]:
            del self._snapshots[stale_id]

    def reachable(self, u, v):
        return self.witness(u, v) is not None

    def witness(self, u, v):
        self._require_initialized()
        self._validate_node(u, "u")
        self._validate_node(v, "v")

        adjacency = self._adjacency()
        distances = {u: 0}
        queue = [u]
        head = 0
        while head < len(queue):
            node = queue[head]
            head += 1
            for neighbor in adjacency[node]:
                if neighbor not in distances:
                    distances[neighbor] = distances[node] + 1
                    queue.append(neighbor)

        if v not in distances:
            return None

        shortest_paths = {u: [u]}
        for distance in range(distances[v]):
            for node in range(self._n):
                if distances.get(node) != distance:
                    continue
                for neighbor in adjacency[node]:
                    if distances.get(neighbor) != distance + 1:
                        continue
                    candidate = shortest_paths[node] + [neighbor]
                    current = shortest_paths.get(neighbor)
                    if current is None or candidate < current:
                        shortest_paths[neighbor] = candidate

        return shortest_paths[v]

    def snapshot_for_testing(self):
        return self._n, set(self._edges)

    def _adjacency(self):
        adjacency = [[] for _ in range(self._n)]
        for u, v in self._edges:
            adjacency[u].append(v)
        for neighbors in adjacency:
            neighbors.sort()
        return adjacency

    def _require_initialized(self):
        if self._n is None:
            raise RuntimeError("graph is not initialized")

    @staticmethod
    def _validate_count(n):
        if not isinstance(n, int) or isinstance(n, bool):
            raise TypeError("n must be an integer")
        if n < 0:
            raise ValueError("n must be non-negative")

    def _validate_node(self, value, name):
        if not isinstance(value, int) or isinstance(value, bool):
            raise TypeError(f"{name} must be an integer")
        if not 0 <= value < self._n:
            raise ValueError(f"{name} is out of range")
