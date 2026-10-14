#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import statistics
import time
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.app.extractors import process_ocr_result
from server.app.ocr_engine import OCRConfig, OCRProcessor


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark PaddleOCR configurations on a private local image set.")
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, help="Optional private JSON ground-truth manifest.")
    parser.add_argument("--model", choices=["v6-small", "v6-tiny", "v5-mobile"], default="v6-small")
    parser.add_argument("--engine", choices=["paddle", "onnxruntime"], default="paddle")
    parser.add_argument("--year", default="2026")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    expected = load_manifest(args.manifest) if args.manifest else {}
    files = sorted(path for path in args.input_dir.iterdir() if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"})
    if args.limit:
        files = files[: args.limit]
    processor = OCRProcessor(OCRConfig(model=args.model, engine=args.engine))
    durations: list[float] = []
    correct = 0
    evaluated = 0
    started = time.perf_counter()
    for index, path in enumerate(files, start=1):
        item_started = time.perf_counter()
        result = processor.recognize(path)
        record = process_ocr_result(path.name, result, args.year)
        duration = time.perf_counter() - item_started
        durations.append(duration)
        marker = ""
        if path.name in expected:
            evaluated += 1
            target = expected[path.name]
            passed = all(target.get(field) == getattr(record, field) for field in ("kind", "date", "amount", "name") if field in target)
            correct += int(passed)
            marker = " ok" if passed else " mismatch"
        print(f"[{index}/{len(files)}] {path.name}: {duration:.2f}s{marker}")
    total = time.perf_counter() - started
    print(json.dumps({
        "model": args.model, "engine": args.engine, "images": len(files), "totalSeconds": round(total, 3),
        "meanSeconds": round(statistics.mean(durations), 3) if durations else 0,
        "medianSeconds": round(statistics.median(durations), 3) if durations else 0,
        "evaluated": evaluated, "correct": correct,
    }, ensure_ascii=False, indent=2))


def load_manifest(path: Path) -> dict[str, dict[str, object]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Manifest must be a JSON object keyed by filename.")
    return value


if __name__ == "__main__":
    main()
