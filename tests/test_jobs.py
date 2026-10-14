from pathlib import Path

from PIL import Image

from server.app.jobs import OCRWorker
from server.app.models import OCRResult
from server.app.ocr_engine import OCRConfig
from server.app.storage import Store


class FakeProcessor:
    config = OCRConfig()

    def recognize(self, _: Path) -> OCRResult:
        return OCRResult(
            text="票据代码 3100\n开票日期 2026年8月1日\n交款人：测试甲\n金额合计（小写）42.00",
            rotation=0,
            score=0.97,
        )


def test_worker_processes_item_and_builds_exports(tmp_path: Path) -> None:
    store = Store(tmp_path)
    batch_id = store.create_batch(year="2026", model="v6-small", engine="paddle", config_hash=OCRConfig().cache_key)
    paths = store.batch_paths(batch_id)
    Image.new("RGB", (320, 200), "white").save(paths["originals"] / "0001.png")
    store.add_item(
        batch_id=batch_id, position=1, original_name="invoice.png", stored_name="0001.png",
        sha256="synthetic", size_bytes=(paths["originals"] / "0001.png").stat().st_size,
    )
    store.queue_batch(batch_id)
    item = store.claim_next_item()
    assert item is not None
    worker = OCRWorker(store)
    worker._processor = lambda model, engine: FakeProcessor()  # type: ignore[method-assign]
    worker._process(item)

    batch = store.get_batch(batch_id)
    assert batch is not None and batch["status"] == "completed"
    assert batch["invoiceCount"] == 1 and batch["totalAmount"] == 42
    assert (paths["reports"] / "summary.json").exists()
    assert list(paths["exports"].glob("*.zip"))
    item_result = store.list_items(batch_id)[0]
    assert item_result["outputName"].startswith("20260801-42元-测试甲")

