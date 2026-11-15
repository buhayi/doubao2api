# SPDX-License-Identifier: AGPL-3.0-only
import unittest
import numpy as np
from PIL import Image
from fixtures import slider, rotation, clicks, words, encoded
from solver import solve, Uncertain, target_text


class LocalRecognitionTests(unittest.TestCase):
    def test_slide_transparent_piece_and_darkened_gap(self):
        for x, y in [(113, 23), (173, 51), (229, 93)]:
            with self.subTest(x=x, y=y):
                result = solve(slider(x, y))
                self.assertLessEqual(abs(result["x"]-x), 3)
                self.assertLessEqual(abs(result["y"]-y), 3)

    def test_rotation_angles(self):
        for angle in (47, 90, 153, 270, 333):
            with self.subTest(angle=angle):
                result = solve(rotation(angle))
                difference = abs((result["angle"]-angle+180) % 360-180)
                self.assertLessEqual(difference, 4)

    def test_ordered_icon_clicks(self):
        request = clicks()
        result = solve(request)
        for got, wanted in zip(result["points"], request["expected"]["points"]):
            self.assertLessEqual(abs(got["x"]-wanted["x"]), 4)
            self.assertLessEqual(abs(got["y"]-wanted["y"]), 4)

    def test_local_character_ocr_order(self):
        request = words()
        if request is None:
            self.skipTest("No test font installed")
        result = solve(request)
        # These symbols are deliberately placed in a different spatial order.
        self.assertGreater(result["points"][0]["x"], result["points"][1]["x"])
        self.assertLess(result["points"][1]["x"], result["points"][2]["x"])

    def test_reject_ambiguous_images(self):
        plain = encoded(Image.fromarray(np.full((300, 300, 4), 255, np.uint8)))
        with self.assertRaises(Uncertain):
            solve({"kind": "rotate", "background": plain, "piece": encoded(Image.new("RGBA", (160, 160), "white")), "pieceScale": 1})
        with self.assertRaises(Uncertain):
            solve({"kind": "slide", "background": plain, "piece": encoded(Image.new("RGBA", (40, 40), "white"))})

    def test_reject_invalid_inputs(self):
        for request in [{}, {"kind": "other"}, {"kind": "slide", "background": "not-base64", "piece": "no"}]:
            with self.assertRaises((Uncertain, KeyError)):
                solve(request)
        self.assertEqual(target_text("请依次点击“木、日、中”"), ["木", "日", "中"])
        self.assertEqual(target_text("请按顺序点击以下图片"), [])


if __name__ == "__main__":
    unittest.main()
