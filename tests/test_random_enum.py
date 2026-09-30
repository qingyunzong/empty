import random
import unittest

from slot import find_slots


def reference(busy, d, s, e, prefer):
    """分钟级枚举对照实现 (仅适用于整数分钟输入)。"""
    free_minutes = [
        m for m in range(s, e)
        if not any(bs <= m < be for person in busy for bs, be in person)
    ]
    runs = []
    for m in free_minutes:
        if runs and runs[-1][1] == m:
            runs[-1][1] = m + 1
        else:
            runs.append([m, m + 1])
    feasible = [(a, b) for a, b in runs if b - a >= d]
    if not feasible:
        return {"status": "none", "slots": []}
    prefer_minutes = {m for ps, pe in prefer for m in range(ps, pe)}
    scored = [(iv, sum(1 for m in range(*iv) if m in prefer_minutes))
              for iv in feasible]
    best = max(score for _, score in scored)
    tied = sorted(iv for iv, score in scored if score == best)
    return {"status": "ok", "score": best, "slots": tied}


def random_case(rng):
    s = 0
    e = rng.randint(20, 90)
    busy = []
    for _ in range(3):  # 3 人
        person = []
        for _ in range(rng.randint(0, 5)):
            a = rng.randint(s, e - 1)
            b = rng.randint(a, e)
            person.append((a, b))
        busy.append(person)
    d = rng.randint(1, 25)
    prefer = []
    for _ in range(rng.randint(0, 4)):
        a = rng.randint(s, e)
        b = rng.randint(a, e)
        prefer.append((a, b))
    return busy, d, s, e, prefer


class TestRandomEnum(unittest.TestCase):
    def test_random_3_person_small_window(self):
        rng = random.Random(20260930)
        for i in range(500):
            busy, d, s, e, prefer = random_case(rng)
            with self.subTest(case=i, busy=busy, d=d, s=s, e=e, prefer=prefer):
                expected = reference(busy, d, s, e, prefer)
                got = find_slots(busy, d, s, e, prefer)
                self.assertEqual(got["status"], expected["status"])
                if expected["status"] == "ok":
                    self.assertEqual(got["score"], expected["score"])
                    self.assertEqual(got["slots"], expected["slots"])
                else:
                    self.assertEqual(got["slots"], [])


if __name__ == "__main__":
    unittest.main()
