import sys
import unittest
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.llm.guardrails import guard_rewrite


class GuardrailTests(unittest.TestCase):
    def test_allows_select(self):
        result = guard_rewrite("SELECT id, name FROM users WHERE active = true")
        self.assertTrue(result.allowed)

    def test_allows_explain_select(self):
        result = guard_rewrite("EXPLAIN SELECT * FROM orders")
        self.assertTrue(result.allowed)

    def test_denies_write_keywords(self):
        result = guard_rewrite("UPDATE users SET name = 'x'")
        self.assertFalse(result.allowed)

    def test_denies_multiple_statements(self):
        result = guard_rewrite("SELECT 1; DELETE FROM users")
        self.assertFalse(result.allowed)


if __name__ == "__main__":
    unittest.main()
