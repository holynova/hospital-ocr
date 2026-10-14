from pathlib import Path

import pytest

from server.app.models import InvoiceRecord, OCRResult
from server.app.storage import Store


def create_queued_item(store: Store, root: Path) -> tuple[str, str]:
    batch_id = store.create_batch(year="2026", model="v6-small", engine="paddle", config_hash="config")
    paths = store.batch_paths(batch_id)
    (paths["originals"] / "0001.png").write_bytes(b"image")
    item_id = store.add_item(
        batch_id=batch_id, position=1, original_name="invoice.png", stored_name="0001.png",
        sha256="abc", size_bytes=5,
    )
    return batch_id, item_id


def test_batch_is_not_claimable_until_upload_finishes(tmp_path: Path) -> None:
    store = Store(tmp_path)
    batch_id, _ = create_queued_item(store, tmp_path)
    assert store.claim_next_item() is None
    store.queue_batch(batch_id)
    item = store.claim_next_item()
    assert item is not None
    assert item["batch_id"] == batch_id


def test_batch_progress_and_cache(tmp_path: Path) -> None:
    store = Store(tmp_path)
    batch_id, item_id = create_queued_item(store, tmp_path)
    store.queue_batch(batch_id)
    assert store.claim_next_item() is not None
    result = OCRResult(text="票据代码\n金额合计（小写）42", rotation=0, score=0.91)
    store.put_cache("abc", "config", result)
    cached = store.get_cache("abc", "config")
    assert cached is not None and cached.from_cache and cached.text == result.text
    record = InvoiceRecord("invoice.png", "", "invoice", "20260801", 42, "测试甲", False, 0, result.text)
    store.complete_item(item_id, record, confidence=0.91, duration_ms=1250, from_cache=False)
    batch = store.get_batch(batch_id)
    assert batch is not None
    assert batch["status"] == "finalizing"
    assert batch["completedCount"] == 1
    assert batch["totalAmount"] == 42
    assert batch["averageDurationMs"] == 1250
    store.finish_batch(batch_id)
    assert store.get_batch(batch_id)["status"] == "completed"


def test_recover_and_retry_interrupted_items(tmp_path: Path) -> None:
    store = Store(tmp_path)
    batch_id, _ = create_queued_item(store, tmp_path)
    store.queue_batch(batch_id)
    assert store.recover_interrupted() == 1
    assert store.get_batch(batch_id)["status"] == "interrupted"
    assert store.retry_batch(batch_id) == 1
    assert store.get_batch(batch_id)["status"] == "queued"


def test_failed_upload_can_retry_saved_items(tmp_path: Path) -> None:
    store = Store(tmp_path)
    batch_id, _ = create_queued_item(store, tmp_path)
    store.fail_upload(batch_id)
    batch = store.get_batch(batch_id)
    assert batch is not None
    assert batch["status"] == "failed"
    assert batch["completedCount"] == 1
    assert batch["failedCount"] == 1
    assert store.retry_batch(batch_id) == 1
    assert store.get_batch(batch_id)["status"] == "queued"


def test_finalizing_batch_cannot_be_deleted(tmp_path: Path) -> None:
    store = Store(tmp_path)
    batch_id, item_id = create_queued_item(store, tmp_path)
    store.queue_batch(batch_id)
    assert store.claim_next_item() is not None
    record = InvoiceRecord("invoice.png", "", "invoice", "20260801", 42, "测试甲", False, 0, "票据")
    store.complete_item(item_id, record, confidence=0.91, duration_ms=10, from_cache=False)
    with pytest.raises(RuntimeError, match="不能删除"):
        store.delete_batch(batch_id)
