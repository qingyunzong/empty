"""Order-statistics tree: an AVL tree augmented with subtree sizes.

Supports insert, delete, select-by-rank and rank-of-key in O(log n).
Values are stored with multiplicities, so the tree acts as a sorted
multiset that never re-sorts previously inserted history.
"""


class _Node:
    __slots__ = ("key", "count", "left", "right", "height", "size")

    def __init__(self, key):
        self.key = key
        self.count = 1
        self.left = None
        self.right = None
        self.height = 1
        self.size = 1


def _height(node):
    return node.height if node is not None else 0


def _size(node):
    return node.size if node is not None else 0


def _pull(node):
    node.height = 1 + max(_height(node.left), _height(node.right))
    node.size = node.count + _size(node.left) + _size(node.right)


def _rotate_right(node):
    pivot = node.left
    node.left = pivot.right
    pivot.right = node
    _pull(node)
    _pull(pivot)
    return pivot


def _rotate_left(node):
    pivot = node.right
    node.right = pivot.left
    pivot.left = node
    _pull(node)
    _pull(pivot)
    return pivot


def _rebalance(node):
    _pull(node)
    balance = _height(node.left) - _height(node.right)
    if balance > 1:
        if _height(node.left.left) < _height(node.left.right):
            node.left = _rotate_left(node.left)
        return _rotate_right(node)
    if balance < -1:
        if _height(node.right.right) < _height(node.right.left):
            node.right = _rotate_right(node.right)
        return _rotate_left(node)
    return node


def _insert(node, key):
    if node is None:
        return _Node(key)
    if key == node.key:
        node.count += 1
    elif key < node.key:
        node.left = _insert(node.left, key)
    else:
        node.right = _insert(node.right, key)
    return _rebalance(node)


def _remove_whole(node, key):
    if key < node.key:
        node.left = _remove_whole(node.left, key)
    elif key > node.key:
        node.right = _remove_whole(node.right, key)
    else:
        if node.left is None:
            return node.right
        if node.right is None:
            return node.left
        succ = node.right
        while succ.left is not None:
            succ = succ.left
        node.key = succ.key
        node.count = succ.count
        node.right = _remove_whole(node.right, succ.key)
    return _rebalance(node)


def _remove(node, key):
    if key < node.key:
        node.left = _remove(node.left, key)
    elif key > node.key:
        node.right = _remove(node.right, key)
    elif node.count > 1:
        node.count -= 1
    else:
        return _remove_whole(node, key)
    return _rebalance(node)


class OrderStatTree:
    """Sorted multiset with rank/select and deletion."""

    def __init__(self):
        self._root = None

    def __len__(self):
        return _size(self._root)

    def __contains__(self, key):
        return self.count_of(key) > 0

    def count_of(self, key):
        node = self._root
        while node is not None:
            if key < node.key:
                node = node.left
            elif key > node.key:
                node = node.right
            else:
                return node.count
        return 0

    def insert(self, key):
        self._root = _insert(self._root, key)

    def remove(self, key):
        """Remove one occurrence of key; raises KeyError if absent."""
        if self.count_of(key) == 0:
            raise KeyError(key)
        self._root = _remove(self._root, key)

    def select(self, k):
        """Return the k-th smallest element (0-based)."""
        if k < 0 or k >= _size(self._root):
            raise IndexError(k)
        node = self._root
        while node is not None:
            left_size = _size(node.left)
            if k < left_size:
                node = node.left
            elif k < left_size + node.count:
                return node.key
            else:
                k -= left_size + node.count
                node = node.right
        raise IndexError(k)  # unreachable when sizes are consistent

    def rank(self, key):
        """Return the number of elements strictly smaller than key."""
        result = 0
        node = self._root
        while node is not None:
            if key <= node.key:
                node = node.left
            else:
                result += _size(node.left) + node.count
                node = node.right
        return result

    def to_list(self):
        out = []

        def walk(node):
            if node is None:
                return
            walk(node.left)
            out.extend([node.key] * node.count)
            walk(node.right)

        walk(self._root)
        return out
