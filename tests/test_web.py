from pathlib import Path

from fastapi.testclient import TestClient

from server.app.jobs import OCRWorker
from server.app.storage import Store
import server.app.web as web


def isolated_client(tmp_path: Path) -> TestClient:
    web.store = Store(tmp_path)
    web.worker = OCRWorker(web.store)
    return TestClient(web.app)


def test_home_and_empty_batch_list(tmp_path: Path) -> None:
    client = isolated_client(tmp_path)
    response = client.get("/")
    assert response.status_code == 200
    assert "票据工作台" in response.text
    assert "平均识别" in response.text
    assert 'id="image-viewer"' in response.text
    assert client.get("/api/batches").json() == {"batches": []}


def test_upload_creates_one_batch(tmp_path: Path) -> None:
    client = isolated_client(tmp_path)
    response = client.post(
        "/api/batches",
        data={"year": "2026", "model": "v6-small", "engine": "paddle"},
        files=[
            ("files", ("first.png", b"first-image", "image/png")),
            ("files", ("second.jpg", b"second-image", "image/jpeg")),
        ],
    )
    assert response.status_code == 202
    batch = response.json()["batch"]
    assert batch["totalCount"] == 2
    assert batch["status"] == "queued"
    items = client.get(f"/api/batches/{batch['id']}/items").json()["items"]
    assert [item["originalName"] for item in items] == ["first.png", "second.jpg"]


def test_rejects_unsupported_file(tmp_path: Path) -> None:
    client = isolated_client(tmp_path)
    response = client.post(
        "/api/batches", data={"year": "2026"},
        files={"files": ("notes.txt", b"not an image", "text/plain")},
    )
    assert response.status_code == 415
    assert "不支持" in response.json()["error"]
