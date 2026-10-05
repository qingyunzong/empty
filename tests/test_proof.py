import copy
import unittest

from symregex import Context, parse, equivalent, verify_proof, EQUIVALENT


class TestProof(unittest.TestCase):
    def setUp(self):
        self.ctx = Context("ab")
        self.left = parse(self.ctx, "(a|b)*abb")
        self.right = parse(self.ctx, "((a|b)(a|b)*)*a(b)(b)")
        res = equivalent(self.ctx, self.left, self.right)
        self.assertEqual(res.status, EQUIVALENT)
        self.proof = res.proof

    def test_valid_proof_verifies(self):
        self.assertTrue(verify_proof(self.ctx, self.left, self.right, self.proof))

    def test_proof_is_json_serializable(self):
        import json
        blob = json.dumps(self.proof)
        self.assertTrue(
            verify_proof(self.ctx, self.left, self.right, json.loads(blob)))

    def test_proof_structure(self):
        p = self.proof
        self.assertEqual(p["kind"], "equivalence-proof")
        self.assertEqual(p["alphabet"], "ab")
        self.assertEqual(p["pairs"][0],
                         [self.ctx.to_str(self.left), self.ctx.to_str(self.right)])
        self.assertTrue(p["edges"])

    def test_tampered_proof_rejected(self):
        ctx, left, right = self.ctx, self.left, self.right
        # 篡改迁移目标
        bad = copy.deepcopy(self.proof)
        bad["edges"][0][2] = (bad["edges"][0][2] + 1) % len(bad["pairs"])
        if verify_proof(ctx, left, right, bad):
            bad["edges"][0][2] = (bad["edges"][0][2] + 1) % len(bad["pairs"])
        self.assertFalse(verify_proof(ctx, left, right, bad))
        # 删除一条迁移（字母表覆盖不全）
        bad = copy.deepcopy(self.proof)
        bad["edges"] = bad["edges"][1:]
        self.assertFalse(verify_proof(ctx, left, right, bad))
        # 篡改 pair 中的表达式
        bad = copy.deepcopy(self.proof)
        bad["pairs"][1][0] = "a"
        self.assertFalse(verify_proof(ctx, left, right, bad))
        # 篡改字母表
        bad = copy.deepcopy(self.proof)
        bad["alphabet"] = "abc"
        self.assertFalse(verify_proof(ctx, left, right, bad))
        # 伪造 kind
        bad = copy.deepcopy(self.proof)
        bad["kind"] = "proof"
        self.assertFalse(verify_proof(ctx, left, right, bad))

    def test_proof_migration_to_other_expressions_rejected(self):
        """把证明迁移到别的表达式对上必须验证失败。"""
        ctx = self.ctx
        other_l = parse(ctx, "a*")
        other_r = parse(ctx, "(a|@)*")
        # 证明本身是为 (left,right) 的，换表达式后无效
        self.assertFalse(verify_proof(ctx, other_l, other_r, self.proof))
        # 但这两式自身的证明可以验证
        res = equivalent(ctx, other_l, other_r)
        self.assertEqual(res.status, EQUIVALENT)
        self.assertTrue(verify_proof(ctx, other_l, other_r, res.proof))
        # 交叉迁移同样失败
        self.assertFalse(verify_proof(ctx, self.left, self.right, res.proof))

    def test_proof_for_trivial_equivalence(self):
        ctx = self.ctx
        a = parse(ctx, "a*")
        res = equivalent(ctx, a, a)
        self.assertEqual(res.status, EQUIVALENT)
        self.assertTrue(verify_proof(ctx, a, a, res.proof))


if __name__ == "__main__":
    unittest.main()
