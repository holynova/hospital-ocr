from __future__ import annotations

import shutil
import threading
import time
import zipfile
from pathlib import Path

from .extractors import fill_missing_names, process_ocr_result
from .ocr_engine import OCRConfig, OCRProcessor
from .reports import write_output_image, write_reports
from .storage import Store


class OCRWorker:
    def __init__(self, store: Store) -> None:
        self.store = store
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._processors: dict[tuple[str, str], OCRProcessor] = {}

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self.store.recover_interrupted()
        self._thread = threading.Thread(target=self._run, name="hospital-ocr-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=5)

    def notify(self) -> None:
        self._wake.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            item = self.store.claim_next_item()
            if item is None:
                batch_id = self.store.next_batch_to_finalize()
                if batch_id:
                    try:
                        self._finalize(batch_id)
                    except Exception:
                        self._wake.wait(timeout=1)
                        self._wake.clear()
                    continue
                self._wake.wait(timeout=1)
                self._wake.clear()
                continue
            self._process(item)

    def _processor(self, model: str, engine: str) -> OCRProcessor:
        key = (model, engine)
        if key not in self._processors:
            self._processors[key] = OCRProcessor(OCRConfig(model=model, engine=engine))
        return self._processors[key]

    def _process(self, item: dict[str, object]) -> None:
        started = time.perf_counter()
        item_id = str(item["id"])
        batch_id = str(item["batch_id"])
        paths = self.store.batch_paths(batch_id)
        source = paths["originals"] / str(item["stored_name"])
        try:
            result = self.store.get_cache(str(item["sha256"]), str(item["config_hash"]))
            if result is None:
                result = self._processor(str(item["model"]), str(item["engine"])).recognize(source)
                self.store.put_cache(str(item["sha256"]), str(item["config_hash"]), result)
            record = process_ocr_result(str(item["original_name"]), result, str(item["year"]))
            self.store.complete_item(
                item_id, record, confidence=result.score,
                duration_ms=int((time.perf_counter() - started) * 1000), from_cache=result.from_cache,
            )
        except Exception as error:
            self.store.fail_item(item_id, _safe_error(error), int((time.perf_counter() - started) * 1000))
        if self.store.batch_needs_finalize(batch_id):
            try:
                self._finalize(batch_id)
            except Exception:
                # Item results remain durable. A later process or retry can rebuild exports.
                return

    def _finalize(self, batch_id: str) -> None:
        paths = self.store.batch_paths(batch_id)
        rows = self.store.item_records(batch_id)
        records = [record for _, record in rows]
        fill_missing_names(records)
        shutil.rmtree(paths["outputs"], ignore_errors=True)
        paths["outputs"].mkdir(parents=True, exist_ok=True)
        used_names: set[str] = set()
        for (item_id, record) in rows:
            item = self.store.get_item_internal(item_id)
            assert item is not None
            source = paths["originals"] / str(item["stored_name"])
            write_output_image(source, paths["outputs"], record, used_names)
            self.store.update_final_record(item_id, record)
        write_reports(records, paths["reports"])
        self._make_zip(paths, batch_id)
        self.store.finish_batch(batch_id)

    def _make_zip(self, paths: dict[str, Path], batch_id: str) -> None:
        destination = paths["exports"] / f"batch-{batch_id[:8]}.zip"
        temporary = destination.with_suffix(".tmp")
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for group in ("outputs", "reports"):
                for file in sorted(paths[group].iterdir()):
                    if file.is_file():
                        archive.write(file, arcname=f"{group}/{file.name}")
        temporary.replace(destination)


def _safe_error(error: Exception) -> str:
    message = str(error).strip()
    if not message:
        message = error.__class__.__name__
    return f"识别失败：{message}"[:1000]
