from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .models import OCRResult


MODEL_PAIRS = {
    "v6-small": ("PP-OCRv6_small_det", "PP-OCRv6_small_rec"),
    "v6-tiny": ("PP-OCRv6_tiny_det", "PP-OCRv6_tiny_rec"),
    "v5-mobile": ("PP-OCRv5_mobile_det", "PP-OCRv5_mobile_rec"),
}


@dataclass(frozen=True)
class OCRConfig:
    model: str = "v6-small"
    engine: str = "paddle"
    max_side: int = 1400
    recognition_batch_size: int = 8
    score_threshold: float = 0.45

    def __post_init__(self) -> None:
        if self.model not in MODEL_PAIRS:
            raise ValueError(f"Unsupported OCR model: {self.model}")
        if self.engine not in {"paddle", "onnxruntime"}:
            raise ValueError(f"Unsupported OCR engine: {self.engine}")

    @property
    def cache_key(self) -> str:
        payload = json.dumps(
            {
                "model": self.model,
                "engine": self.engine,
                "max_side": self.max_side,
                "recognition_batch_size": self.recognition_batch_size,
                "score_threshold": self.score_threshold,
                "orientation": "PP-LCNet_x1_0_doc_ori",
                "schema": 1,
            },
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode()).hexdigest()


class OCRProcessor:
    def __init__(self, config: OCRConfig | None = None) -> None:
        self.config = config or OCRConfig()
        self._pipeline: Any | None = None

    def _load(self) -> Any:
        if self._pipeline is not None:
            return self._pipeline
        os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
        from paddleocr import PaddleOCR

        detection, recognition = MODEL_PAIRS[self.config.model]
        kwargs: dict[str, object] = {
            "text_detection_model_name": detection,
            "text_recognition_model_name": recognition,
            "doc_orientation_classify_model_name": "PP-LCNet_x1_0_doc_ori",
            "use_doc_orientation_classify": True,
            "use_doc_unwarping": False,
            "use_textline_orientation": False,
            "text_det_limit_side_len": self.config.max_side,
            "text_det_limit_type": "max",
            "text_recognition_batch_size": self.config.recognition_batch_size,
        }
        if self.config.engine != "paddle":
            kwargs["engine"] = self.config.engine
        self._pipeline = PaddleOCR(**kwargs)
        return self._pipeline

    def recognize(self, image_path: Path) -> OCRResult:
        result = self._load().predict(
            str(image_path),
            use_doc_orientation_classify=True,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            text_det_limit_side_len=self.config.max_side,
            text_det_limit_type="max",
            text_rec_score_thresh=self.config.score_threshold,
        )
        lines: list[str] = []
        scores: list[float] = []
        rotation = 0
        for page in result:
            mapping = _as_mapping(page)
            texts = mapping.get("rec_texts", [])
            rec_scores = mapping.get("rec_scores", [])
            for text, score in zip(texts, rec_scores):
                numeric_score = float(score)
                if numeric_score >= self.config.score_threshold and str(text).strip():
                    lines.append(str(text).strip())
                    scores.append(numeric_score)
            rotation = _extract_rotation(mapping)
        average_score = sum(scores) / len(scores) if scores else 0.0
        return OCRResult(text="\n".join(lines), rotation=rotation, score=average_score)


def _as_mapping(page: Any) -> Mapping[str, Any]:
    if isinstance(page, Mapping):
        return page
    if hasattr(page, "get"):
        return {
            key: page.get(key, default)
            for key, default in {
                "rec_texts": [], "rec_scores": [], "angle": None, "doc_preprocessor_res": None,
            }.items()
        }
    if hasattr(page, "json"):
        value = page.json
        if callable(value):
            value = value()
        if isinstance(value, Mapping):
            nested = value.get("res")
            return nested if isinstance(nested, Mapping) else value
    return {}


def _extract_rotation(mapping: Mapping[str, Any]) -> int:
    values: list[Any] = [mapping.get("angle")]
    preprocessed = mapping.get("doc_preprocessor_res")
    if isinstance(preprocessed, Mapping):
        values.append(preprocessed.get("angle"))
        nested = preprocessed.get("res")
        if isinstance(nested, Mapping):
            values.append(nested.get("angle"))
    for value in values:
        if value is None:
            continue
        try:
            angle = int(value)
        except (TypeError, ValueError):
            continue
        if angle in {0, 90, 180, 270}:
            return angle
        if angle in {1, 2, 3}:
            return angle * 90
    return 0
