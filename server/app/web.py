from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .jobs import OCRWorker
from .ocr_engine import OCRConfig
from .storage import FINAL_BATCH_STATUSES, Store


APP_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = APP_DIR.parent.parent
STATIC_DIR = APP_DIR / "static"
TEMPLATE_DIR = APP_DIR / "templates"
DATA_DIR = Path(os.environ.get("HOSPITAL_OCR_DATA_DIR", PROJECT_ROOT / "data"))
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"}
MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_BATCH_FILES = 500

store = Store(DATA_DIR)
worker = OCRWorker(store)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    worker.start()
    try:
        yield
    finally:
        worker.stop()


app = FastAPI(title="Hospital Invoice OCR", docs_url=None, redoc_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    return HTMLResponse((TEMPLATE_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/batches")
def list_batches(limit: int = 50, offset: int = 0) -> dict[str, object]:
    return {"batches": store.list_batches(limit=min(max(limit, 1), 100), offset=max(offset, 0))}


@app.post("/api/batches", status_code=202)
async def create_batch(
    files: list[UploadFile] = File(...),
    year: str = Form(default_factory=lambda: os.environ.get("INVOICE_YEAR", "2026")),
    model: str = Form("v6-small"),
    engine: str = Form("paddle"),
) -> dict[str, object]:
    if not files:
        raise HTTPException(status_code=400, detail="请选择至少一张图片。")
    if len(files) > MAX_BATCH_FILES:
        raise HTTPException(status_code=400, detail=f"单个批次最多上传 {MAX_BATCH_FILES} 张图片。")
    if not (year.isdigit() and len(year) == 4 and 2000 <= int(year) <= 2100):
        raise HTTPException(status_code=400, detail="年份必须是 2000 到 2100 之间的四位数字。")
    config = _config_or_400(model, engine)
    names = [upload.filename or "unnamed" for upload in files]
    unsupported = [name for name in names if Path(name).suffix.lower() not in IMAGE_EXTENSIONS]
    if unsupported:
        raise HTTPException(status_code=415, detail=f"不支持的文件类型：{unsupported[0]}")

    batch_id = store.create_batch(year=year, model=model, engine=engine, config_hash=config.cache_key)
    paths = store.batch_paths(batch_id)
    try:
        for position, upload in enumerate(files, start=1):
            suffix = Path(upload.filename or "image").suffix.lower()
            stored_name = f"{position:04d}{suffix}"
            destination = paths["originals"] / stored_name
            digest = hashlib.sha256()
            size = 0
            with destination.open("wb") as output:
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_FILE_BYTES:
                        raise HTTPException(status_code=413, detail=f"{upload.filename} 超过 100MB 上限。")
                    digest.update(chunk)
                    output.write(chunk)
            await upload.close()
            if size == 0:
                raise HTTPException(status_code=400, detail=f"{upload.filename} 是空文件。")
            store.add_item(
                batch_id=batch_id, position=position, original_name=Path(upload.filename or stored_name).name,
                stored_name=stored_name, sha256=digest.hexdigest(), size_bytes=size,
            )
        store.queue_batch(batch_id)
    except Exception:
        store.fail_upload(batch_id)
        raise
    worker.notify()
    batch = store.get_batch(batch_id)
    assert batch is not None
    return {"batch": batch}


@app.get("/api/batches/{batch_id}")
def get_batch(batch_id: str) -> dict[str, object]:
    batch = _batch_or_404(batch_id)
    return {"batch": batch}


@app.get("/api/batches/{batch_id}/items")
def list_items(batch_id: str, limit: int = 50, offset: int = 0) -> dict[str, object]:
    _batch_or_404(batch_id)
    return {"items": store.list_items(batch_id, limit=min(max(limit, 1), 100), offset=max(offset, 0))}


@app.get("/api/batches/{batch_id}/events")
def batch_events(batch_id: str) -> StreamingResponse:
    _batch_or_404(batch_id)

    async def events() -> AsyncIterator[str]:
        last_updated = ""
        while True:
            batch = store.get_batch(batch_id)
            if batch is None:
                yield "event: deleted\ndata: {}\n\n"
                return
            if batch["updatedAt"] != last_updated:
                last_updated = str(batch["updatedAt"])
                payload = json.dumps(batch, ensure_ascii=False)
                yield f"event: progress\ndata: {payload}\n\n"
            if batch["status"] in FINAL_BATCH_STATUSES | {"failed", "interrupted"}:
                return
            await asyncio.sleep(0.75)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.post("/api/batches/{batch_id}/retry")
def retry_batch(batch_id: str) -> dict[str, object]:
    _batch_or_404(batch_id)
    count = store.retry_batch(batch_id)
    if count:
        worker.notify()
    return {"retried": count, "batch": store.get_batch(batch_id)}


@app.delete("/api/batches/{batch_id}")
def delete_batch(batch_id: str) -> dict[str, bool]:
    _batch_or_404(batch_id)
    root = store.batch_paths(batch_id)["root"].resolve()
    expected_parent = (store.data_dir / "batches").resolve()
    if root.parent != expected_parent:
        raise HTTPException(status_code=400, detail="批次路径不安全，已拒绝删除。")
    try:
        deleted = store.delete_batch(batch_id)
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if deleted:
        shutil.rmtree(root, ignore_errors=True)
    return {"deleted": deleted}


@app.get("/api/items/{item_id}/original")
def item_original(item_id: str) -> FileResponse:
    row = store.get_item_internal(item_id)
    if not row:
        raise HTTPException(status_code=404, detail="未找到图片。")
    path = store.batch_paths(str(row["batch_id"]))["originals"] / str(row["stored_name"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="原图文件不存在。")
    return FileResponse(path, filename=str(row["original_name"]))


@app.get("/api/batches/{batch_id}/exports/{format_name}")
def export_batch(batch_id: str, format_name: str) -> FileResponse:
    _batch_or_404(batch_id)
    paths = store.batch_paths(batch_id)
    if format_name == "zip":
        files = list(paths["exports"].glob("*.zip"))
        path = files[0] if files else None
    else:
        names = {"json": "summary.json", "csv": "summary.csv", "markdown": "summary.md", "ocr": "ocr-text.json"}
        path = paths["reports"] / names[format_name] if format_name in names else None
    if path is None or not path.exists():
        raise HTTPException(status_code=409, detail="批次尚未生成该导出文件。")
    return FileResponse(path, filename=path.name)


@app.exception_handler(404)
def not_found(_: Request, __: Exception) -> HTMLResponse:
    if _.url.path.startswith("/api/"):
        return JSONResponse({"error": "未找到请求的资源。"}, status_code=404)
    return HTMLResponse(
        "<!doctype html><html lang='zh-CN'><meta charset='utf-8'><title>页面不存在</title>"
        "<body style='font-family:-apple-system,PingFang SC,sans-serif;padding:48px;background:#f5f1e8;color:#233538'>"
        "<h1>页面不存在</h1><p>这个地址没有对应的页面。</p><a href='/'>返回批次工作台</a></body></html>", status_code=404,
    )


@app.exception_handler(HTTPException)
def http_error(request: Request, error: HTTPException) -> JSONResponse | HTMLResponse:
    if request.url.path.startswith("/api/"):
        return JSONResponse({"error": error.detail}, status_code=error.status_code)
    return HTMLResponse(str(error.detail), status_code=error.status_code)


def _config_or_400(model: str, engine: str) -> OCRConfig:
    try:
        return OCRConfig(model=model, engine=engine)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def _batch_or_404(batch_id: str) -> dict[str, object]:
    batch = store.get_batch(batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="未找到这个批次。")
    return batch
