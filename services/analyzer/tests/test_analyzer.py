import sys
import unittest
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.analyzer import analyze
from app.plan_parser import NormalizedNode, parse_explain_json


class PlanParserTests(unittest.TestCase):
    def test_parses_plan_object_and_computes_totals(self):
        explain = {
            "Plan": {
                "Node Type": "Seq Scan",
                "Relation Name": "users",
                "Plan Rows": 10,
                "Plan Width": 32,
                "Actual Rows": 5,
                "Actual Loops": 4,
                "Filter": "(status = 'active'::text)",
            }
        }
        root = parse_explain_json(explain)
        self.assertIsInstance(root, NormalizedNode)
        self.assertEqual(root.node_type, "Seq Scan")
        self.assertEqual(root.relation_name, "users")
        self.assertEqual(root.actual_total_rows, 20)

    def test_parses_top_level_array(self):
        explain = [
            {
                "Plan": {
                    "Node Type": "Seq Scan",
                    "Relation Name": "projects",
                    "Plan Rows": 2,
                    "Actual Rows": 2,
                    "Actual Loops": 1,
                }
            }
        ]
        root = parse_explain_json(explain)
        self.assertEqual(root.node_type, "Seq Scan")
        self.assertEqual(root.children, [])


class HeuristicsTests(unittest.TestCase):
    def test_rules_and_primary_bottleneck_selected(self):
        explain = {
            "Plan": {
                "Node Type": "Nested Loop",
                "Plan Rows": 1000,
                "Plan Width": 64,
                "Actual Rows": 80000,
                "Actual Loops": 1,
                "Plans": [
                    {
                        "Node Type": "Seq Scan",
                        "Relation Name": "users",
                        "Plan Rows": 500,
                        "Plan Width": 64,
                        "Actual Rows": 60000,
                        "Actual Loops": 1,
                        "Filter": "(status = 'active'::text)",
                    },
                    {
                        "Node Type": "Sort",
                        "Sort Method": "external merge Disk",
                        "Sort Space Type": "Disk",
                        "Sort Space Used": 1024,
                        "Plan Rows": 1200,
                        "Plan Width": 300,
                        "Actual Rows": 20000,
                        "Actual Loops": 1,
                        "Plans": [
                            {
                                "Node Type": "Seq Scan",
                                "Relation Name": "orders",
                                "Plan Rows": 1000,
                                "Plan Width": 300,
                                "Actual Rows": 20000,
                                "Actual Loops": 1,
                                "Filter": "(user_id = users.id)",
                            }
                        ],
                    },
                ],
            }
        }
        sql = "SELECT * FROM users JOIN orders ON orders.user_id = users.id WHERE lower(users.email) IN ('a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v')"

        output = analyze(sql, explain)

        self.assertIsNotNone(output.primary_bottleneck)
        self.assertGreaterEqual(len(output.findings), 5)
        self.assertGreaterEqual(len(output.suggested_indexes), 1)
        self.assertGreaterEqual(len(output.anti_patterns), 2)
        self.assertEqual(output.findings[0].code, "ROW_MISESTIMATE")


if __name__ == "__main__":
    unittest.main()
