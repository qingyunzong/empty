"""Deletable order-statistics structure (AVL tree augmented with subtree sizes).

Supports insert/delete with multiplicity, select(k), and rank(x) in O(log n).
Used to maintain exact medians and ranks incrementally without re-sorting
the full history of values on every update.
"""

from __future__ import annotations


class _Node:
    __slots__ = ("key", "count", "height", "size", "left", "right")

    def __init__(self, key):
        self.key = key
        self.count = 1
        self.height = 1
        self.size = 1
        self.left = None
        self.right = None


def _height(node):
    return node.height if node else 0


def _size(node):
    return node.size if node else 0


def _pull(node):
    node.height = 1 + max(_height(node.left), _height(node.right))
    node.size = node.count + _size(node.left) + _size(node.right)


def _rotate_right(y):
    x = y.left
    y.left = x.right
    x.right = y
    _pull(y)
    _pull(x)
    return x


def _rotate_left(x):
    y = x.right
    x.right = y.left
    y.left = x
    _pull(x)
    _pull(y)
    return y


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


class OrderStats:
    """Multiset with O(log n) insert/delete/select/rank."""

    __slots__ = ("_root", "_n")

    def __init__(self):
        self._root = None
        self._n = 0

    def __len__(self):
        return self._n

    def insert(self, key, count=1):
        if count <= 0:
            raise ValueError("count must be positive")
        self._root = self._insert(self._root, key, count)
        self._n += count

    def _insert(self, node, key, count):
        if node is None:
            node = _Node(key)
            node.count = count
            node.size = count
            return node
        if key < node.key:
            node.left = self._insert(node.left, key, count)
        elif key > node.key:
            node.right = self._insert(node.right, key, count)
        else:
            node.count += count
            node.size += count
            return node
        return _rebalance(node)

    def delete(self, key, count=1):
        if count <= 0:
            raise ValueError("count must be positive")
        self._root = self._delete(self._root, key, count)
        self._n -= count

    def _delete(self, node, key, count):
        if node is None:
            raise KeyError(key)
        if key < node.key:
            node.left = self._delete(node.left, key, count)
        elif key > node.key:
            node.right = self._delete(node.right, key, count)
        else:
            if count > node.count:
                raise KeyError(key)
            if count < node.count:
                node.count -= count
                node.size -= count
                return node
            if node.left is None:
                return node.right
            if node.right is None:
                return node.left
            succ = node.right
            while succ.left:
                succ = succ.left
            node.key = succ.key
            node.count = succ.count
            node.right = self._delete(node.right, succ.key, succ.count)
        return _rebalance(node)

    def select(self, k):
        """Return the k-th smallest element (0-indexed)."""
        if k < 0 or k >= self._n:
            raise IndexError(k)
        node = self._root
        while node:
            left = _size(node.left)
            if k < left:
                node = node.left
            elif k < left + node.count:
                return node.key
            else:
                k -= left + node.count
                node = node.right
        raise IndexError(k)  # unreachable

    def rank(self, key):
        """Return the number of elements strictly less than key."""
        r = 0
        node = self._root
        while node:
            if key <= node.key:
                node = node.left
            else:
                r += _size(node.left) + node.count
                node = node.right
        return r

    def count_of(self, key):
        node = self._root
        while node:
            if key < node.key:
                node = node.left
            elif key > node.key:
                node = node.right
            else:
                return node.count
        return 0

    def items(self):
        """In-order (key, multiplicity) pairs."""
        out = []
        stack = []
        node = self._root
        while stack or node:
            while node:
                stack.append(node)
                node = node.left
            node = stack.pop()
            out.append((node.key, node.count))
            node = node.right
        return out

    def clear(self):
        self._root = None
        self._n = 0
