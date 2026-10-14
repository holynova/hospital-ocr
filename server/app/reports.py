from __future__ import annotations

import csv
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageOps

from .models import InvoiceRecord


def format_money(value: float) -> str:
    rounded = round(float(value) + 1e-9, 2)
    return str(int(rounded)) if rounded.is_integer() else f"{rounded:.2f}".rstrip("0")


def safe_filename(value: str) -> str:
    return (re.sub(r"\s+", "", re.sub(r'[\\/:*?"<>|]', "_", value))[:40] or "未知姓名")


def write_output_image(source: Path, output_dir: Path, record: InvoiceRecord, used_names: set[str]) -> Path:
    suffix = source.suffix.lower() or ".png"
    if record.skipped:
        base = f"unmatched-{safe_filename(source.stem)}"
    elif record.kind == "medical_record":
        base = f"{record.date}-病例-{safe_filename(record.name)}"
    else:
        base = f"{record.date}-{format_money(record.amount or 0)}元-{safe_filename(record.name)}"
    candidate = output_dir / f"{base}{suffix}"
    count = 2
    while candidate.name in used_names or candidate.exists():
        candidate = output_dir / f"{base}-{count}{suffix}"
        count += 1
    used_names.add(candidate.name)
    with Image.open(source) as image:
        corrected = ImageOps.exif_transpose(image)
        if record.rotation:
            corrected = corrected.rotate(record.rotation, expand=True)
        corrected.save(candidate)
    record.output_name = candidate.name
    return candidate


def build_summary(records: Iterable[InvoiceRecord]) -> dict[str, object]:
    rows = list(records)
    invoices = [record for record in rows if record.kind == "invoice"]
    medical = [record for record in rows if record.kind == "medical_record"]
    skipped = [record for record in rows if record.skipped]
    daily: dict[str, dict[str, float | int]] = defaultdict(lambda: {"count": 0, "amount": 0.0})
    for record in invoices:
        daily[record.date]["count"] = int(daily[record.date]["count"]) + 1
        daily[record.date]["amount"] = round(float(daily[record.date]["amount"]) + (record.amount or 0), 2)
    medical_daily: dict[str, int] = defaultdict(int)
    for record in medical:
        medical_daily[record.date] += 1
    return {
        "totalCount": len(invoices),
        "totalAmount": round(sum(record.amount or 0 for record in invoices), 2),
        "medicalRecordCount": len(medical),
        "unknownCount": len(skipped),
        "daily": dict(sorted(daily.items())),
        "medicalDaily": dict(sorted(medical_daily.items())),
        "invoices": [record.public_dict() for record in invoices],
        "medicalRecords": [record.public_dict() for record in medical],
        "skipped": [record.public_dict() for record in skipped],
    }


def write_reports(records: list[InvoiceRecord], output_dir: Path) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    summary = build_summary(records)
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (output_dir / "summary.md").write_text(make_markdown(summary), encoding="utf-8")
    with (output_dir / "summary.csv").open("w", encoding="utf-8", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["kind", "date", "amount", "name", "original_name", "output_name", "rotation"])
        for record in records:
            writer.writerow([record.kind, record.date, "" if record.amount is None else format_money(record.amount), record.name, record.original_name, record.output_name, record.rotation])
    (output_dir / "ocr-text.json").write_text(
        json.dumps([{"originalName": row.original_name, "outputName": row.output_name, "text": row.text} for row in records], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary


def make_markdown(summary: dict[str, object]) -> str:
    lines = [
        "# 发票统计", "", f"- 发票张数：{summary['totalCount']}",
        f"- 总金额：{format_money(float(summary['totalAmount']))} 元",
        f"- 病例张数：{summary['medicalRecordCount']}", f"- 未识别：{summary['unknownCount']}", "",
        "## 每日小结", "", "| 日期 | 张数 | 金额 |", "| --- | ---: | ---: |",
    ]
    for date, item in dict(summary["daily"]).items():
        lines.append(f"| {date} | {item['count']} | {format_money(float(item['amount']))} 元 |")
    lines.extend(["", "## 发票明细", "", "| 日期 | 金额 | 姓名 | 原文件 | 输出文件 |", "| --- | ---: | --- | --- | --- |"])
    for item in summary["invoices"]:
        lines.append(f"| {item['date']} | {format_money(float(item['amount']))} 元 | {item['name']} | {item['originalName']} | {item['outputName']} |")
    if summary["medicalRecords"]:
        lines.extend(["", "## 病例明细", "", "| 日期 | 姓名 | 原文件 | 输出文件 | 旋转 |", "| --- | --- | --- | --- | ---: |"])
        for item in summary["medicalRecords"]:
            lines.append(f"| {item['date']} | {item['name']} | {item['originalName']} | {item['outputName']} | {item['rotation']} |")
    if summary["skipped"]:
        lines.extend(["", "## 未计入统计", "", "| 原文件 | 输出文件 | 原因 |", "| --- | --- | --- |"])
        for item in summary["skipped"]:
            lines.append(f"| {item['originalName']} | {item['outputName']} | 未识别为发票或病例 |")
    return "\n".join(lines) + "\n"

