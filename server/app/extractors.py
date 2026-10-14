from __future__ import annotations

import os
import re
from collections import Counter
from pathlib import Path

from .models import InvoiceRecord, OCRResult


def process_ocr_result(original_name: str, result: OCRResult, year: str) -> InvoiceRecord:
    filename_hints = parse_filename_hints(original_name, year)
    date = extract_date(result.text, filename_hints) or str(filename_hints.get("date") or "unknown-date")
    amount = extract_amount(result.text)
    kind = classify_document(result.text, amount)
    if amount is None and kind == "invoice":
        hint_amount = filename_hints.get("amount")
        amount = float(hint_amount) if hint_amount is not None else 0.0
    name = extract_name(result.text) or os.environ.get("DEFAULT_INVOICE_NAME") or "未知姓名"
    return InvoiceRecord(
        original_name=original_name,
        output_name="",
        kind=kind,
        date=date,
        amount=amount,
        name=name,
        skipped=kind == "unknown",
        rotation=result.rotation,
        text=result.text,
    )


def extract_date(text: str, hints: dict[str, object]) -> str | None:
    compact = normalize_text(text)
    candidates: dict[str, int] = {}

    def add(raw: str, score: int, *, boost_matching_hint: bool = True) -> None:
        date = normalize_date(raw)
        if not date:
            return
        hint_score = 100 if boost_matching_hint and hints.get("month_day") == date[4:8] else 0
        candidates[date] = max(candidates.get(date, 0), score + hint_score)

    patterns = [
        (r"开票日期[:：]?\s*((?:20\d{2})[-./年]?\d{1,2}[-./月]?\d{1,2})", 100),
        (r"就诊日期[:：]?\s*((?:20\d{2})[-./年]?\d{1,2}[-./月]?\d{1,2})", 90),
        (r"\b(20\d{6})\b", 50),
        (r"\b(20\d{2}[-./年]\d{1,2}[-./月]\d{1,2})", 45),
    ]
    for pattern, score in patterns:
        for match in re.finditer(pattern, compact):
            add(match.group(1), score)
    for match in re.finditer(r"(20\d{2})年?(\d{1,2})月?(\d{1,2})(?=\D|\d{2}[:：]\d{2}|$)", compact):
        add(f"{match.group(1)}{int(match.group(2)):02d}{int(match.group(3)):02d}", 85)
    for match in re.finditer(r"(20\d{2})[-./年](\d{1,2})[-./月](\d{1,2})", compact):
        add(f"{match.group(1)}{int(match.group(2)):02d}{int(match.group(3)):02d}", 80)
    if hints.get("date"):
        add(str(hints["date"]), 40, boost_matching_hint=False)
    return sorted(candidates, key=lambda item: (-candidates[item], item))[0] if candidates else None


def extract_amount(text: str) -> float | None:
    compact = re.sub(r"\s+", "", normalize_text(text))
    for pattern in [
        r"[（(]小写[）)]([0-9]+(?:\.[0-9]{1,2})?)",
        r"金额合计.*?[（(]小写[）)]([0-9]+(?:\.[0-9]{1,2})?)",
        r"(?:诊察费|诊查费|治疗费)([0-9]+(?:\.[0-9]{1,2})?)",
    ]:
        match = re.search(pattern, compact)
        if match:
            return float(match.group(1))
    return None


def extract_name(text: str) -> str | None:
    bad_words = re.compile(
        r"统一|社会|信用|代码|校验码|票据|项目名称|开票日期|金额|业务流水|门诊号|医保|性别|"
        r"医师|签章|医院|名称|日期|记录|推拿科|注意|事项|个月|月|天|岁|"
        r"西医|中医|治疗|病情|处理|复诊"
    )
    lines = normalize_text(text).splitlines()
    for line in lines:
        match = re.search(r"(?:交款人|缴款人|患者姓名|姓名)[:：]\s*([\u4e00-\u9fa5]{2,6})", line)
        name = clean_name_candidate(match.group(1) if match else None)
        if name and not bad_words.search(name):
            return name
    for line in lines:
        match = re.search(r"(?:交款人|缴款人|患者姓名|姓名)([\u4e00-\u9fa5]{2,6})", re.sub(r"\s+", "", line))
        name = clean_name_candidate(match.group(1) if match else None)
        if name and not bad_words.search(name):
            return name
    compact = re.sub(r"\s+", "", normalize_text(text))
    clean_lines = [line.strip() for line in lines if line.strip()]
    for index, line in enumerate(clean_lines):
        if "就医记录" in line:
            for candidate in clean_lines[index + 1:index + 8]:
                name = clean_name_candidate(candidate)
                if name and not bad_words.search(name) and name not in {"岳阳医院", "推拿科", "医师签章", "医院名称"}:
                    return name
    for line in lines:
        name = clean_name_candidate(line.strip())
        if name and not bad_words.search(name):
            return name
    return None


def clean_name_candidate(value: str | None) -> str | None:
    if not value:
        return None
    name = re.sub(r"[^\u4e00-\u9fa5]", "", value)
    if len(name) == 4 and name.startswith("和"):
        name = name[1:]
    return name if 2 <= len(name) <= 4 else None


def parse_filename_hints(filename: str, year: str) -> dict[str, object]:
    match = re.match(r"^(\d{1,2}):(\d{1,2})-(\d+(?:\.\d+)?)", Path(filename).stem)
    if not match:
        return {}
    month_day = f"{int(match.group(1)):02d}{int(match.group(2)):02d}"
    return {"date": f"{year}{month_day}", "month_day": month_day, "amount": float(match.group(3))}


def normalize_date(raw: str) -> str | None:
    digits = re.sub(r"[^\d]", "", raw)
    if len(digits) > 8 and digits.startswith("20"):
        digits = digits[:8]
    if len(digits) != 8:
        return None
    year, month, day = int(digits[:4]), int(digits[4:6]), int(digits[6:8])
    if not (2000 <= year <= 2100 and 1 <= month <= 12 and 1 <= day <= 31):
        return None
    return digits


def normalize_text(text: str) -> str:
    normalized = text.translate(str.maketrans({"；": ":", ";": ":", "，": ",", "（": "(", "）": ")", "：": ":", "．": "."}))
    return "".join(chr(ord(char) - 0xFEE0) if "０" <= char <= "９" else char for char in normalized)


def classify_document(text: str, amount: float | None) -> str:
    compact = re.sub(r"\s+", "", normalize_text(text))
    if (amount or 0) > 0 and re.search(r"票据代码|票据号码|金额合计|开票日期|就诊日期", compact):
        return "invoice"
    if re.search(r"就医记录|门诊病历|病历|复诊治疗|目前病情|处理[:：]?中医治疗|医师签章", compact):
        return "medical_record"
    return "unknown"


def fill_missing_names(records: list[InvoiceRecord]) -> None:
    counts = Counter(record.name for record in records if not record.skipped and record.name != "未知姓名")
    if not counts:
        return
    dominant, count = counts.most_common(1)[0]
    if count < 3:
        return
    for record in records:
        if record.skipped:
            continue
        if record.name == "未知姓名" or (record.kind == "medical_record" and record.name != dominant) or is_suspicious_name(record.name, dominant):
            record.name = dominant


def is_suspicious_name(name: str, dominant: str) -> bool:
    return (len(name) < 3 and dominant.endswith(name)) or bool(re.search(r"医|治疗|病情|处理|复诊|医院|签章|名称|日期|记录|科", name))
