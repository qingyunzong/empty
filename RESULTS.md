# 实际测试结果

```
    Start 3: fixpoint
3/4 Test #3: fixpoint .........................   Passed    0.01 sec
    Start 4: deletion
4/4 Test #4: deletion .........................   Passed    0.01 sec

100% tests passed, 0 tests failed out of 4

Total Test time (real) =   0.05 sec
```

## 各用例实际 points-to 输出

```
--- basic ---
pts(q) = {obj@1, obj@2}
pts(p) = {obj@1}
pts(y) = {obj@2}
pts(x) = {obj@1}
basic: PASS
--- fields ---
pts(w) = {obj@11}
pts(v) = {obj@10}
pts(p) = {obj@20}
pts(y) = {obj@11}
pts(x) = {obj@10}
fld(obj@20, f) = {obj@10}
fld(obj@20, g) = {obj@11}
fields: PASS
--- fixpoint ---
pts(cur) = {obj@1, obj@2}
pts(n1) = {obj@2}
pts(n0) = {obj@1}
fld(obj@1, next) = {obj@2}
fld(obj@2, next) = {obj@1}
fixpoint: PASS
--- before deletion ---
pts(v) = {obj@10, obj@11}
pts(r) = {obj@20}
pts(y) = {obj@11}
pts(x) = {obj@10}
pts(q) = {obj@1, obj@2}
pts(p) = {obj@1, obj@2}
pts(b) = {obj@2}
pts(a) = {obj@1}
fld(obj@20, f) = {obj@10, obj@11}
--- after deletion ---
pts(v) = {obj@10}
pts(r) = {obj@20}
pts(y) = {obj@11}
pts(x) = {obj@10}
pts(q) = {obj@1}
pts(p) = {obj@1}
pts(b) = {obj@2}
pts(a) = {obj@1}
fld(obj@20, f) = {obj@10}
deletion result == from-empty recomputation
deletion: PASS
```
