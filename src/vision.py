"""Template matching: find a known image inside a screenshot."""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class Match:
    x: int
    y: int
    w: int
    h: int
    confidence: float

    @property
    def center(self) -> tuple[int, int]:
        return self.x + self.w // 2, self.y + self.h // 2


def find_template(
    haystack: np.ndarray,
    template_path: str,
    threshold: float = 0.85,
) -> Match | None:
    """Find `template_path` inside `haystack`. Returns None if confidence < threshold."""
    template = cv2.imread(template_path, cv2.IMREAD_COLOR)
    if template is None:
        raise FileNotFoundError(f"Could not load template: {template_path}")

    result = cv2.matchTemplate(haystack, template, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(result)

    if max_val < threshold:
        return None

    h, w = template.shape[:2]
    return Match(x=max_loc[0], y=max_loc[1], w=w, h=h, confidence=float(max_val))


def find_all(
    haystack: np.ndarray,
    template_path: str,
    threshold: float = 0.85,
) -> list[Match]:
    """Find every occurrence of a template above `threshold`."""
    template = cv2.imread(template_path, cv2.IMREAD_COLOR)
    if template is None:
        raise FileNotFoundError(f"Could not load template: {template_path}")

    result = cv2.matchTemplate(haystack, template, cv2.TM_CCOEFF_NORMED)
    ys, xs = np.where(result >= threshold)
    h, w = template.shape[:2]
    return [
        Match(x=int(x), y=int(y), w=w, h=h, confidence=float(result[y, x]))
        for x, y in zip(xs, ys)
    ]
