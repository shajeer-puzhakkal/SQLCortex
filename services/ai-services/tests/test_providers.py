import json
import os
import sys
import unittest
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.providers import mock_provider
from app.providers.router import route_generate_text


class ProviderRouterTests(unittest.TestCase):
    def setUp(self):
        self._env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)

    def test_router_selects_mock_provider(self):
        os.environ["AI_PROVIDER"] = "mock"
        os.environ["AI_MODEL"] = "mock-model"
        os.environ["AI_TIMEOUT_MS"] = "123"

        result = route_generate_text("system", "user")

        self.assertEqual(result.provider, "mock")
        self.assertEqual(result.model, "mock-model")
        self.assertIsInstance(result.latency_ms, int)

    def test_mock_output_is_stable(self):
        output = mock_provider.generate_text("system", "user", model="mock", timeout_ms=1)
        expected_payload = {
            "summary": "Mock response from SQLCortex.",
            "findings": [
                "Mock finding: sequential scan on large table.",
                "Mock finding: join order could be improved.",
            ],
            "recommendations": [
                "Mock recommendation: add index on filter column.",
                "Mock recommendation: reduce selected columns to lower I/O.",
            ],
            "risk_level": "low",
        }
        expected = json.dumps(
            expected_payload,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        )
        self.assertEqual(output, expected)


if __name__ == "__main__":
    unittest.main()
