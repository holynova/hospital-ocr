#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.app.extractors import fill_missing_names, process_ocr_result
from server.app.models import OCRResult
from server.app.ocr_engine import OCRConfig, OCRProcessor
from server.app.reports import format_money, write_output_image, write_reports
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"}


def main() -> None:
    parser = argparse.ArgumentParser(description="Use PaddleOCR to rename and summarize hospital invoice images.")
    parser.add_argument("--input-dir", type=Path, default=ROOT / "inputs")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs_paddleocr")
    parser.add_argument("--year", default=os.environ.get("INVOICE_YEAR", "2026"))
    parser.add_argument("--model", choices=["v6-small", "v6-tiny", "v5-mobile"], default="v6-small")
    parser.add_argument("--engine", choices=["paddle", "onnxruntime"], default="paddle")
    parser.add_argument("--max-side", type=int, default=1400)
    parser.add_argument("--recognition-batch-size", type=int, default=8)
    parser.add_argument("--cache-path", type=Path, default=ROOT / ".paddleocr-cache.json")
    parser.add_argument("--no-cache", action="store_true")
    args = parser.parse_args()

    if not args.input_dir.exists():
        parser.error(f"Input directory does not exist: {args.input_dir}")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    config = OCRConfig(
        model=args.model, engine=args.engine, max_side=args.max_side,
        recognition_batch_size=args.recognition_batch_size,
    )
    processor = OCRProcessor(config)
    cache = {} if args.no_cache else load_cache(args.cache_path)
    files = sorted(
        (path for path in args.input_dir.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS),
        key=lambda path: path.name,
    )
    records = []
    started = time.perf_counter()
    for index, image_path in enumerate(files, start=1):
        item_started = time.perf_counter()
        key = f"{file_sha256(image_path)}:{config.cache_key}"
        cached = cache.get(key)
        if isinstance(cached, dict):
            result = OCRResult(
                text=str(cached.get("text", "")), rotation=int(cached.get("rotation", 0)),
                score=float(cached.get("score", 0)), from_cache=True,
            )
        else:
            result = processor.recognize(image_path)
            if not args.no_cache:
                cache[key] = {"text": result.text, "rotation": result.rotation, "score": result.score}
        record = process_ocr_result(image_path.name, result, args.year)
        records.append(record)
        label = {"invoice": "发票", "medical_record": "病例", "unknown": "未知"}[record.kind]
        amount = f" {format_money(record.amount)}元" if record.amount is not None else ""
        cache_label = " cache" if result.from_cache else ""
        print(f"OCR [{index}/{len(files)}] {image_path.name}: {record.date}{amount} {record.name} {label}{cache_label} ({time.perf_counter() - item_started:.1f}s)")

    fill_missing_names(records)
    used_names: set[str] = set()
    for record in records:
        write_output_image(args.input_dir / record.original_name, args.output_dir, record, used_names)
    summary = write_reports(records, args.output_dir)
    if not args.no_cache:
        save_cache(args.cache_path, cache)
    print()
    print(f"完成：{summary['totalCount']} 张发票，总金额 {format_money(float(summary['totalAmount']))} 元；{summary['medicalRecordCount']} 张病例。")
    print(f"总耗时：{time.perf_counter() - started:.1f}s")
    print(f"结果目录：{args.output_dir}")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def load_cache(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_cache(path: Path, cache: dict[str, object]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


if __name__ == "__main__":
    main()
