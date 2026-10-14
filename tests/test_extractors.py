from server.app.extractors import extract_amount, extract_date, extract_name, process_ocr_result
from server.app.models import OCRResult


def test_extracts_invoice_fields() -> None:
    text = """医疗收费电子票据
    票据代码 3100123456
    开票日期：2026年7月24日
    交款人：测试甲
    金额合计（小写）123.45
    """
    record = process_ocr_result("scan.jpg", OCRResult(text=text, rotation=0), "2026")
    assert record.kind == "invoice"
    assert record.date == "20260724"
    assert record.amount == 123.45
    assert record.name == "测试甲"
    assert not record.skipped


def test_extracts_medical_record_fields() -> None:
    text = """门诊病历
    患者姓名：测试乙
    就诊日期：2026-07-27
    医师签章
    """
    record = process_ocr_result("record.jpg", OCRResult(text=text, rotation=90), "2026")
    assert record.kind == "medical_record"
    assert record.date == "20260727"
    assert record.amount is None
    assert record.name == "测试乙"
    assert record.rotation == 90


def test_filename_hint_is_lower_priority_than_ocr_date() -> None:
    hints = {"date": "20260701", "month_day": "0701"}
    assert extract_date("开票日期 2026年7月2日", hints) == "20260702"


def test_full_width_digits_and_compact_name() -> None:
    assert extract_amount("金额合计（小写）４２．００") == 42
    assert extract_name("缴款人测试丙") == "测试丙"


def test_names_do_not_require_a_person_specific_rule() -> None:
    assert extract_name("患者姓名：张三") == "张三"
    assert extract_name("患者姓名：李四") == "李四"
    assert extract_name("统一社会信用代码 123456789") is None
