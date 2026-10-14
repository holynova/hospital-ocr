from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass
class OCRResult:
    text: str
    rotation: int
    score: float = 0.0
    from_cache: bool = False


@dataclass
class InvoiceRecord:
    original_name: str
    output_name: str
    kind: str
    date: str
    amount: float | None
    name: str
    skipped: bool
    rotation: int
    text: str

    def public_dict(self) -> dict[str, object]:
        data = asdict(self)
        data.pop("text", None)
        data.pop("skipped", None)
        return {
            "originalName": data["original_name"],
            "outputName": data["output_name"],
            "kind": data["kind"],
            "date": data["date"],
            "amount": data["amount"],
            "name": data["name"],
            "rotation": data["rotation"],
        }

