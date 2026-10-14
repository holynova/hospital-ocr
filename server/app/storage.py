from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from .models import InvoiceRecord, OCRResult


FINAL_ITEM_STATUSES = {"completed", "failed"}
FINAL_BATCH_STATUSES = {"completed", "completed_with_errors"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class Store:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir.resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.data_dir / "hospital_invoice_ocr.sqlite3"
        self.initialize()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS batches (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    status TEXT NOT NULL,
                    year TEXT NOT NULL,
                    model TEXT NOT NULL,
                    engine TEXT NOT NULL,
                    config_hash TEXT NOT NULL,
                    total_count INTEGER NOT NULL DEFAULT 0,
                    completed_count INTEGER NOT NULL DEFAULT 0,
                    success_count INTEGER NOT NULL DEFAULT 0,
                    failed_count INTEGER NOT NULL DEFAULT 0,
                    invoice_count INTEGER NOT NULL DEFAULT 0,
                    medical_count INTEGER NOT NULL DEFAULT 0,
                    unknown_count INTEGER NOT NULL DEFAULT 0,
                    total_amount_cents INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS items (
                    id TEXT PRIMARY KEY,
                    batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
                    position INTEGER NOT NULL,
                    original_name TEXT NOT NULL,
                    stored_name TEXT NOT NULL,
                    sha256 TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    output_name TEXT,
                    kind TEXT,
                    document_date TEXT,
                    amount_cents INTEGER,
                    person_name TEXT,
                    rotation INTEGER NOT NULL DEFAULT 0,
                    ocr_text TEXT,
                    confidence REAL,
                    duration_ms INTEGER,
                    from_cache INTEGER NOT NULL DEFAULT 0,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(batch_id, position)
                );

                CREATE INDEX IF NOT EXISTS items_batch_position ON items(batch_id, position);
                CREATE INDEX IF NOT EXISTS items_status ON items(status, created_at);

                CREATE TABLE IF NOT EXISTS ocr_cache (
                    sha256 TEXT NOT NULL,
                    config_hash TEXT NOT NULL,
                    text TEXT NOT NULL,
                    rotation INTEGER NOT NULL,
                    confidence REAL NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (sha256, config_hash)
                );
                """
            )

    def recover_interrupted(self) -> int:
        now = utc_now()
        with self.connect() as connection:
            cursor = connection.execute(
                "UPDATE items SET status = 'interrupted', error = ?, updated_at = ? WHERE status IN ('queued', 'running')",
                ("服务在识别期间停止，可以重试此文件。", now),
            )
            connection.execute(
                "UPDATE batches SET status = 'interrupted', updated_at = ? WHERE status IN ('uploading', 'queued', 'running')",
                (now,),
            )
            return cursor.rowcount

    def create_batch(self, *, year: str, model: str, engine: str, config_hash: str) -> str:
        batch_id = uuid.uuid4().hex
        now = utc_now()
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO batches (id, created_at, updated_at, status, year, model, engine, config_hash) VALUES (?, ?, ?, 'uploading', ?, ?, ?, ?)",
                (batch_id, now, now, year, model, engine, config_hash),
            )
        self.batch_paths(batch_id)
        return batch_id

    def batch_paths(self, batch_id: str) -> dict[str, Path]:
        root = self.data_dir / "batches" / batch_id
        paths = {
            "root": root,
            "originals": root / "originals",
            "outputs": root / "outputs",
            "reports": root / "reports",
            "exports": root / "exports",
        }
        for path in paths.values():
            path.mkdir(parents=True, exist_ok=True)
        return paths

    def add_item(self, *, batch_id: str, position: int, original_name: str, stored_name: str, sha256: str, size_bytes: int) -> str:
        item_id = uuid.uuid4().hex
        now = utc_now()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO items (id, batch_id, position, original_name, stored_name, sha256, size_bytes, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_upload', ?, ?)
                """,
                (item_id, batch_id, position, original_name, stored_name, sha256, size_bytes, now, now),
            )
            connection.execute("UPDATE batches SET total_count = total_count + 1, updated_at = ? WHERE id = ?", (now, batch_id))
        return item_id

    def queue_batch(self, batch_id: str) -> None:
        with self.connect() as connection:
            count = connection.execute("SELECT total_count FROM batches WHERE id = ?", (batch_id,)).fetchone()
            if not count:
                raise KeyError(batch_id)
            status = "queued" if count["total_count"] else "failed"
            connection.execute(
                "UPDATE items SET status = 'queued', updated_at = ? WHERE batch_id = ? AND status = 'pending_upload'",
                (utc_now(), batch_id),
            )
            connection.execute("UPDATE batches SET status = ?, updated_at = ? WHERE id = ?", (status, utc_now(), batch_id))

    def fail_upload(self, batch_id: str) -> None:
        now = utc_now()
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE items
                SET status = 'failed', error = '批次上传未完成，可以重试已保存的图片', updated_at = ?
                WHERE batch_id = ? AND status = 'pending_upload'
                """,
                (now, batch_id),
            )
            connection.execute(
                """
                UPDATE batches
                SET status = 'failed', completed_count = total_count, failed_count = total_count,
                    finished_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (now, now, batch_id),
            )

    def claim_next_item(self) -> dict[str, object] | None:
        now = utc_now()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT items.*, batches.year, batches.model, batches.engine, batches.config_hash
                FROM items JOIN batches ON batches.id = items.batch_id
                WHERE items.status = 'queued'
                ORDER BY batches.created_at, items.position LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            connection.execute("UPDATE items SET status = 'running', error = NULL, updated_at = ? WHERE id = ?", (now, row["id"]))
            connection.execute(
                "UPDATE batches SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
                (now, now, row["batch_id"]),
            )
            return dict(row)

    def get_cache(self, sha256: str, config_hash: str) -> OCRResult | None:
        with self.connect() as connection:
            row = connection.execute("SELECT text, rotation, confidence FROM ocr_cache WHERE sha256 = ? AND config_hash = ?", (sha256, config_hash)).fetchone()
        if not row:
            return None
        return OCRResult(text=row["text"], rotation=row["rotation"], score=row["confidence"], from_cache=True)

    def put_cache(self, sha256: str, config_hash: str, result: OCRResult) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO ocr_cache (sha256, config_hash, text, rotation, confidence, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(sha256, config_hash) DO UPDATE SET text = excluded.text, rotation = excluded.rotation,
                    confidence = excluded.confidence, created_at = excluded.created_at
                """,
                (sha256, config_hash, result.text, result.rotation, result.score, utc_now()),
            )

    def complete_item(self, item_id: str, record: InvoiceRecord, *, confidence: float, duration_ms: int, from_cache: bool) -> None:
        now = utc_now()
        amount_cents = None if record.amount is None else int(round(record.amount * 100))
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE items SET status = 'completed', output_name = ?, kind = ?, document_date = ?, amount_cents = ?,
                    person_name = ?, rotation = ?, ocr_text = ?, confidence = ?, duration_ms = ?, from_cache = ?,
                    error = NULL, updated_at = ? WHERE id = ?
                """,
                (record.output_name or None, record.kind, record.date, amount_cents, record.name, record.rotation, record.text,
                 confidence, duration_ms, int(from_cache), now, item_id),
            )
        self._refresh_batch_for_item(item_id)

    def fail_item(self, item_id: str, error: str, duration_ms: int) -> None:
        with self.connect() as connection:
            connection.execute(
                "UPDATE items SET status = 'failed', error = ?, duration_ms = ?, updated_at = ? WHERE id = ?",
                (error[:1000], duration_ms, utc_now(), item_id),
            )
        self._refresh_batch_for_item(item_id)

    def _refresh_batch_for_item(self, item_id: str) -> None:
        with self.connect() as connection:
            row = connection.execute("SELECT batch_id FROM items WHERE id = ?", (item_id,)).fetchone()
            if row:
                self._refresh_batch(connection, row["batch_id"])

    def _refresh_batch(self, connection: sqlite3.Connection, batch_id: str) -> None:
        stats = connection.execute(
            """
            SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN ('completed', 'failed') THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS success,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status = 'completed' AND kind = 'invoice' THEN 1 ELSE 0 END) AS invoices,
                SUM(CASE WHEN status = 'completed' AND kind = 'medical_record' THEN 1 ELSE 0 END) AS medical,
                SUM(CASE WHEN status = 'completed' AND kind = 'unknown' THEN 1 ELSE 0 END) AS unknown_count,
                SUM(CASE WHEN status = 'completed' AND kind = 'invoice' THEN COALESCE(amount_cents, 0) ELSE 0 END) AS amount
            FROM items WHERE batch_id = ?
            """,
            (batch_id,),
        ).fetchone()
        assert stats is not None
        done, total, failed = int(stats["done"] or 0), int(stats["total"] or 0), int(stats["failed"] or 0)
        status = "running"
        finished_at = None
        if total and done == total:
            status = "finalizing"
        connection.execute(
            """
            UPDATE batches SET status = ?, completed_count = ?, success_count = ?, failed_count = ?, invoice_count = ?,
                medical_count = ?, unknown_count = ?, total_amount_cents = ?, finished_at = COALESCE(?, finished_at), updated_at = ?
            WHERE id = ?
            """,
            (status, done, int(stats["success"] or 0), failed, int(stats["invoices"] or 0), int(stats["medical"] or 0),
             int(stats["unknown_count"] or 0), int(stats["amount"] or 0), finished_at, utc_now(), batch_id),
        )

    def list_batches(self, *, limit: int = 50, offset: int = 0) -> list[dict[str, object]]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT batches.*,
                    (SELECT AVG(duration_ms) FROM items
                     WHERE items.batch_id = batches.id AND items.status = 'completed' AND duration_ms IS NOT NULL) AS average_duration_ms
                FROM batches ORDER BY created_at DESC LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ).fetchall()
        return [serialize_batch(dict(row)) for row in rows]

    def get_batch(self, batch_id: str) -> dict[str, object] | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT batches.*,
                    (SELECT AVG(duration_ms) FROM items
                     WHERE items.batch_id = batches.id AND items.status = 'completed' AND duration_ms IS NOT NULL) AS average_duration_ms
                FROM batches WHERE batches.id = ?
                """,
                (batch_id,),
            ).fetchone()
        return serialize_batch(dict(row)) if row else None

    def list_items(self, batch_id: str, *, limit: int = 50, offset: int = 0) -> list[dict[str, object]]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM items WHERE batch_id = ? ORDER BY position LIMIT ? OFFSET ?", (batch_id, limit, offset)).fetchall()
        return [serialize_item(dict(row)) for row in rows]

    def get_item(self, item_id: str) -> dict[str, object] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        return serialize_item(dict(row)) if row else None

    def get_item_internal(self, item_id: str) -> dict[str, object] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        return dict(row) if row else None

    def item_records(self, batch_id: str) -> list[tuple[str, InvoiceRecord]]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM items WHERE batch_id = ? AND status = 'completed' ORDER BY position", (batch_id,)).fetchall()
        records: list[tuple[str, InvoiceRecord]] = []
        for row in rows:
            records.append((row["id"], InvoiceRecord(
                original_name=row["original_name"], output_name=row["output_name"] or "", kind=row["kind"] or "unknown",
                date=row["document_date"] or "unknown-date", amount=None if row["amount_cents"] is None else row["amount_cents"] / 100,
                name=row["person_name"] or "未知姓名", skipped=row["kind"] == "unknown", rotation=row["rotation"] or 0,
                text=row["ocr_text"] or "",
            )))
        return records

    def update_final_record(self, item_id: str, record: InvoiceRecord) -> None:
        with self.connect() as connection:
            connection.execute(
                "UPDATE items SET output_name = ?, person_name = ?, updated_at = ? WHERE id = ?",
                (record.output_name, record.name, utc_now(), item_id),
            )

    def batch_needs_finalize(self, batch_id: str) -> bool:
        batch = self.get_batch(batch_id)
        return bool(batch and batch["status"] == "finalizing")

    def next_batch_to_finalize(self) -> str | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT id FROM batches WHERE status = 'finalizing' ORDER BY created_at LIMIT 1"
            ).fetchone()
        return str(row["id"]) if row else None

    def finish_batch(self, batch_id: str) -> None:
        with self.connect() as connection:
            row = connection.execute("SELECT failed_count FROM batches WHERE id = ?", (batch_id,)).fetchone()
            if not row:
                raise KeyError(batch_id)
            status = "completed_with_errors" if int(row["failed_count"] or 0) else "completed"
            now = utc_now()
            connection.execute(
                "UPDATE batches SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?",
                (status, now, now, batch_id),
            )

    def retry_batch(self, batch_id: str) -> int:
        now = utc_now()
        with self.connect() as connection:
            cursor = connection.execute(
                "UPDATE items SET status = 'queued', error = NULL, duration_ms = NULL, updated_at = ? WHERE batch_id = ? AND status IN ('failed', 'interrupted')",
                (now, batch_id),
            )
            if cursor.rowcount:
                connection.execute("UPDATE batches SET status = 'queued', finished_at = NULL, updated_at = ? WHERE id = ?", (now, batch_id))
                self._refresh_batch(connection, batch_id)
                connection.execute("UPDATE batches SET status = 'queued', finished_at = NULL, updated_at = ? WHERE id = ?", (now, batch_id))
            return cursor.rowcount

    def delete_batch(self, batch_id: str) -> bool:
        with self.connect() as connection:
            row = connection.execute("SELECT status FROM batches WHERE id = ?", (batch_id,)).fetchone()
            if not row:
                return False
            if row["status"] in {"uploading", "queued", "running", "finalizing"}:
                raise RuntimeError("正在处理的批次不能删除")
            connection.execute("DELETE FROM batches WHERE id = ?", (batch_id,))
        return True

    def set_batch_updated(self, batch_id: str) -> None:
        with self.connect() as connection:
            connection.execute("UPDATE batches SET updated_at = ? WHERE id = ?", (utc_now(), batch_id))


def serialize_batch(row: dict[str, object]) -> dict[str, object]:
    return {
        "id": row["id"], "createdAt": row["created_at"], "updatedAt": row["updated_at"],
        "startedAt": row["started_at"], "finishedAt": row["finished_at"], "status": row["status"],
        "year": row["year"], "model": row["model"], "engine": row["engine"], "totalCount": row["total_count"],
        "completedCount": row["completed_count"], "successCount": row["success_count"], "failedCount": row["failed_count"],
        "invoiceCount": row["invoice_count"], "medicalCount": row["medical_count"], "unknownCount": row["unknown_count"],
        "totalAmount": round(int(row["total_amount_cents"] or 0) / 100, 2),
        "averageDurationMs": batch_average_duration(row),
    }


def batch_average_duration(row: dict[str, object]) -> int | None:
    if "average_duration_ms" in row:
        value = row.get("average_duration_ms")
        return None if value is None else int(round(float(value)))
    return None


def serialize_item(row: dict[str, object]) -> dict[str, object]:
    return {
        "id": row["id"], "batchId": row["batch_id"], "position": row["position"], "originalName": row["original_name"],
        "sizeBytes": row["size_bytes"], "status": row["status"], "outputName": row["output_name"], "kind": row["kind"],
        "date": row["document_date"], "amount": None if row["amount_cents"] is None else round(row["amount_cents"] / 100, 2),
        "name": row["person_name"], "rotation": row["rotation"], "confidence": row["confidence"],
        "durationMs": row["duration_ms"], "fromCache": bool(row["from_cache"]), "error": row["error"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }
