"use strict";

const PAGE_SIZE = 50;
const STATUS = {
  uploading: ["正在上传", "正在保存图片"],
  queued: ["等待处理", "批次已进入识别队列"],
  running: ["正在识别", "模型正在逐张处理图片"],
  finalizing: ["正在生成报告", "识别已结束，正在整理图片和导出文件"],
  interrupted: ["处理已中断", "服务曾在识别期间停止，可以重试中断项"],
  completed: ["处理完成", "所有图片已经处理完成"],
  completed_with_errors: ["部分完成", "批次已完成，部分图片识别失败"],
  failed: ["批次失败", "这个批次没有完成上传或识别"],
};

const KIND = { invoice: "发票", medical_record: "病例", unknown: "未识别" };
const ITEM_STATUS = { queued: "等待", running: "识别中", completed: "完成", failed: "失败", interrupted: "已中断" };

const state = {
  files: [],
  batches: [],
  currentBatch: null,
  currentItems: [],
  currentPage: 0,
  events: null,
  busy: false,
  elapsedTimer: null,
  viewerItem: null,
  viewerRotation: 0,
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  batchList: $("#batch-list"), historyEmpty: $("#history-empty"), refreshBatches: $("#refresh-batches"),
  fileInput: $("#file-input"), chooseFiles: $("#choose-files"), dropZone: $("#drop-zone"),
  selectionSummary: $("#selection-summary"), uploadForm: $("#upload-form"), startUpload: $("#start-upload"),
  uploadError: $("#upload-error"), yearInput: $("#year-input"), modelInput: $("#model-input"), engineState: $("#engine-state span:last-child"),
  welcomePanel: $("#welcome-panel"), batchPanel: $("#batch-panel"), batchTime: $("#batch-time"), batchTitle: $("#batch-title"),
  statusLabel: $("#status-label"), progressMessage: $("#progress-message"), progressPercent: $("#progress-percent"),
  progressTrack: $(".progress-track"), progressBar: $("#progress-bar"), summaryCompleted: $("#summary-completed"),
  summaryElapsed: $("#summary-elapsed"), summaryAverage: $("#summary-average"),
  summaryInvoices: $("#summary-invoices"), summaryMedical: $("#summary-medical"), summaryUnknown: $("#summary-unknown"),
  summaryAmount: $("#summary-amount"), retryBatch: $("#retry-batch"), deleteBatch: $("#delete-batch"),
  exportRow: $("#export-row"), resultsBody: $("#results-body"), resultsEmpty: $("#results-empty"), resultsCaption: $("#results-caption"),
  previousPage: $("#previous-page"), nextPage: $("#next-page"), pageLabel: $("#page-label"),
  confirmLayer: $("#confirm-layer"), cancelDelete: $("#cancel-delete"), confirmDelete: $("#confirm-delete"),
  imageViewer: $("#image-viewer"), viewerImage: $("#viewer-image"), viewerTitle: $("#viewer-title"),
  viewerRotation: $("#viewer-rotation"), rotateLeft: $("#rotate-left"), rotateRight: $("#rotate-right"),
  resetRotation: $("#reset-rotation"), closeViewer: $("#close-viewer"), viewerStage: $("#viewer-stage"),
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function formatDate(value, withTime = true) {
  if (!value) return "";
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", withTime ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false } : { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function formatMoney(value) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: Number(value) % 1 ? 2 : 0 }).format(Number(value || 0));
}

function formatDuration(milliseconds) {
  if (milliseconds == null) return "暂无";
  if (milliseconds < 1000) return `${milliseconds}ms`;
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}分 ${String(seconds).padStart(2, "0")}秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours}时 ${String(minutes % 60).padStart(2, "0")}分`;
}

function elapsedMilliseconds(batch) {
  const start = new Date(batch.startedAt || batch.createdAt).getTime();
  const end = batch.finishedAt ? new Date(batch.finishedAt).getTime() : Date.now();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || data?.detail || `请求失败（${response.status}）`);
  return data;
}

async function loadBatches({ selectLatest = false } = {}) {
  const data = await api("/api/batches?limit=50");
  state.batches = data.batches;
  renderBatchList();
  if (selectLatest && !state.currentBatch && state.batches.length) await openBatch(state.batches[0].id);
}

function renderBatchList() {
  elements.historyEmpty.hidden = state.batches.length > 0;
  elements.batchList.innerHTML = state.batches.map((batch) => {
    const selected = state.currentBatch?.id === batch.id;
    const label = STATUS[batch.status]?.[0] || batch.status;
    return `<button class="batch-link" type="button" data-batch-id="${batch.id}" data-status="${batch.status}" aria-current="${selected}">
      <span class="batch-link-title"><span class="batch-state-dot" aria-hidden="true"></span>${formatDate(batch.createdAt)} · ${escapeHtml(label)}</span>
      <span class="batch-link-count">${batch.completedCount}/${batch.totalCount}</span>
      <span class="batch-link-meta">${batch.invoiceCount} 张发票 · ${formatMoney(batch.totalAmount)}</span>
    </button>`;
  }).join("");
}

async function openBatch(batchId) {
  stopEvents();
  const data = await api(`/api/batches/${batchId}`);
  state.currentBatch = data.batch;
  state.currentPage = 0;
  elements.welcomePanel.hidden = true;
  elements.batchPanel.hidden = false;
  renderBatch();
  renderBatchList();
  await loadItems();
  if (["uploading", "queued", "running", "finalizing"].includes(state.currentBatch.status)) startEvents(batchId);
}

function renderBatch() {
  const batch = state.currentBatch;
  if (!batch) return;
  const completed = batch.completedCount || 0;
  const total = batch.totalCount || 0;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const [label, message] = STATUS[batch.status] || [batch.status, ""];
  elements.batchTime.textContent = `${formatDate(batch.createdAt)} · ${batch.model}`;
  elements.batchTitle.textContent = `批次 ${batch.id.slice(0, 8)}`;
  elements.statusLabel.textContent = label;
  elements.statusLabel.dataset.status = batch.status;
  elements.progressMessage.textContent = message;
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressTrack.setAttribute("aria-valuenow", String(percent));
  elements.progressBar.style.width = `${percent}%`;
  elements.summaryCompleted.textContent = `${completed} / ${total}`;
  elements.summaryElapsed.textContent = formatElapsed(elapsedMilliseconds(batch));
  elements.summaryAverage.textContent = formatDuration(batch.averageDurationMs);
  elements.summaryInvoices.textContent = String(batch.invoiceCount);
  elements.summaryMedical.textContent = String(batch.medicalCount);
  elements.summaryUnknown.textContent = String(batch.unknownCount);
  elements.summaryAmount.textContent = formatMoney(batch.totalAmount);
  elements.engineState.textContent = modelLabel(batch.model);
  const retryable = ["interrupted", "completed_with_errors", "failed"].includes(batch.status) && batch.failedCount + (total - completed) > 0;
  elements.retryBatch.hidden = !retryable;
  elements.deleteBatch.disabled = ["uploading", "queued", "running", "finalizing"].includes(batch.status);
  const finished = ["completed", "completed_with_errors"].includes(batch.status);
  elements.exportRow.hidden = !finished;
  elements.exportRow.querySelectorAll("a").forEach((link) => { link.href = `/api/batches/${batch.id}/exports/${link.dataset.export}`; });
  syncElapsedTimer(batch);
}

function syncElapsedTimer(batch) {
  const active = ["uploading", "queued", "running", "finalizing"].includes(batch.status);
  if (active && !state.elapsedTimer) {
    state.elapsedTimer = window.setInterval(() => {
      if (state.currentBatch) elements.summaryElapsed.textContent = formatElapsed(elapsedMilliseconds(state.currentBatch));
    }, 1000);
  } else if (!active && state.elapsedTimer) {
    window.clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }
}

async function loadItems() {
  if (!state.currentBatch) return;
  const offset = state.currentPage * PAGE_SIZE;
  const data = await api(`/api/batches/${state.currentBatch.id}/items?limit=${PAGE_SIZE}&offset=${offset}`);
  state.currentItems = data.items;
  renderItems();
}

function renderItems() {
  const batch = state.currentBatch;
  const items = state.currentItems;
  elements.resultsEmpty.hidden = items.length > 0;
  elements.resultsBody.innerHTML = items.map((item) => `<tr data-item-status="${item.status}">
    <td><div class="file-cell">
      <button class="thumbnail-button" type="button" data-preview-item="${item.id}" aria-label="查看 ${escapeHtml(item.originalName)} 大图"><img src="/api/items/${item.id}/original" alt="${escapeHtml(item.originalName)} 缩略图" width="42" height="42" loading="lazy"><span aria-hidden="true">查看</span></button>
      <span class="file-name">${escapeHtml(item.originalName)}${item.error ? `<span class="item-error">${escapeHtml(item.error)}</span>` : ""}</span>
    </div></td>
    <td><span class="item-status" data-status="${item.status}">${ITEM_STATUS[item.status] || item.status}${item.fromCache ? " · 缓存" : ""}</span></td>
    <td>${KIND[item.kind] || "暂无"}</td>
    <td>${item.date ? escapeHtml(item.date) : "暂无"}</td>
    <td>${item.amount == null ? "暂无" : formatMoney(item.amount)}</td>
    <td>${escapeHtml(item.name || "暂无")}</td>
    <td>${formatDuration(item.durationMs)}</td>
  </tr>`).join("");
  const totalPages = Math.max(1, Math.ceil((batch?.totalCount || 0) / PAGE_SIZE));
  elements.pageLabel.textContent = `第 ${state.currentPage + 1} / ${totalPages} 页`;
  elements.previousPage.disabled = state.currentPage === 0;
  elements.nextPage.disabled = state.currentPage + 1 >= totalPages;
  const start = state.currentPage * PAGE_SIZE + 1;
  const end = Math.min((state.currentPage + 1) * PAGE_SIZE, batch?.totalCount || 0);
  elements.resultsCaption.textContent = batch?.totalCount ? `显示第 ${start}–${end} 张，共 ${batch.totalCount} 张` : "按上传顺序显示";
}

function openImageViewer(itemId) {
  const item = state.currentItems.find((candidate) => candidate.id === itemId);
  if (!item) return;
  state.viewerItem = item;
  state.viewerRotation = 0;
  elements.viewerTitle.textContent = item.originalName;
  elements.viewerImage.src = `/api/items/${item.id}/original`;
  elements.viewerImage.alt = `${item.originalName} 大图`;
  elements.imageViewer.hidden = false;
  document.body.classList.add("viewer-open");
  updateViewerRotation();
  elements.closeViewer.focus();
}

function closeImageViewer() {
  if (elements.imageViewer.hidden) return;
  const itemId = state.viewerItem?.id;
  elements.imageViewer.hidden = true;
  elements.viewerImage.removeAttribute("src");
  document.body.classList.remove("viewer-open");
  state.viewerItem = null;
  document.querySelector(`[data-preview-item="${itemId}"]`)?.focus();
}

function rotateImage(delta) {
  state.viewerRotation = (state.viewerRotation + delta + 360) % 360;
  updateViewerRotation();
}

function updateViewerRotation() {
  elements.viewerImage.style.transform = `translate(-50%, -50%) rotate(${state.viewerRotation}deg)`;
  elements.viewerImage.dataset.rotation = String(state.viewerRotation);
  const quarterTurn = state.viewerRotation % 180 !== 0;
  const stageWidth = Math.max(120, elements.viewerStage.clientWidth - 56);
  const stageHeight = Math.max(120, elements.viewerStage.clientHeight - 56);
  const naturalWidth = elements.viewerImage.naturalWidth || stageWidth;
  const naturalHeight = elements.viewerImage.naturalHeight || stageHeight;
  const scale = Math.min(
    1,
    (quarterTurn ? stageHeight : stageWidth) / naturalWidth,
    (quarterTurn ? stageWidth : stageHeight) / naturalHeight,
  );
  elements.viewerImage.style.width = `${Math.round(naturalWidth * scale)}px`;
  elements.viewerImage.style.height = `${Math.round(naturalHeight * scale)}px`;
  elements.viewerImage.style.maxWidth = "none";
  elements.viewerImage.style.maxHeight = "none";
  elements.viewerRotation.textContent = `当前方向 ${state.viewerRotation}°`;
  elements.resetRotation.disabled = state.viewerRotation === 0;
}

elements.viewerImage.addEventListener("load", () => { if (!elements.imageViewer.hidden) updateViewerRotation(); });

function startEvents(batchId) {
  stopEvents();
  state.events = new EventSource(`/api/batches/${batchId}/events`);
  state.events.addEventListener("progress", async (event) => {
    if (state.currentBatch?.id !== batchId) return;
    state.currentBatch = JSON.parse(event.data);
    renderBatch();
    await loadItems();
    await loadBatches();
    if (!["uploading", "queued", "running", "finalizing"].includes(state.currentBatch.status)) stopEvents();
  });
  state.events.onerror = () => {
    stopEvents();
    window.setTimeout(async () => {
      if (state.currentBatch?.id !== batchId) return;
      const data = await api(`/api/batches/${batchId}`).catch(() => null);
      if (!data) return;
      state.currentBatch = data.batch;
      renderBatch();
      await loadItems();
      if (["uploading", "queued", "running", "finalizing"].includes(state.currentBatch.status)) startEvents(batchId);
    }, 1500);
  };
}

function stopEvents() {
  state.events?.close();
  state.events = null;
}

function setFiles(files) {
  const supported = ["image/png", "image/jpeg", "image/webp", "image/tiff", "image/bmp"];
  state.files = Array.from(files).filter((file) => supported.includes(file.type) || /\.(png|jpe?g|webp|tiff?|bmp)$/i.test(file.name));
  const bytes = state.files.reduce((sum, file) => sum + file.size, 0);
  elements.selectionSummary.textContent = state.files.length ? `${state.files.length} 张图片 · ${formatSize(bytes)}` : "尚未选择图片";
  elements.startUpload.disabled = state.files.length === 0 || state.busy;
  elements.uploadError.hidden = true;
}

async function submitBatch(event) {
  event.preventDefault();
  if (!state.files.length || state.busy) return;
  state.busy = true;
  elements.startUpload.disabled = true;
  elements.startUpload.querySelector("span").textContent = "正在上传…";
  elements.uploadError.hidden = true;
  const formData = new FormData();
  state.files.forEach((file) => formData.append("files", file));
  formData.append("year", elements.yearInput.value);
  formData.append("model", elements.modelInput.value);
  formData.append("engine", "paddle");
  try {
    const data = await api("/api/batches", { method: "POST", body: formData });
    setFiles([]);
    elements.fileInput.value = "";
    await loadBatches();
    await openBatch(data.batch.id);
  } catch (error) {
    elements.uploadError.textContent = error.message;
    elements.uploadError.hidden = false;
  } finally {
    state.busy = false;
    elements.startUpload.querySelector("span").textContent = "创建批次并识别";
    elements.startUpload.disabled = state.files.length === 0;
  }
}

async function retryCurrentBatch() {
  if (!state.currentBatch) return;
  elements.retryBatch.disabled = true;
  try {
    const data = await api(`/api/batches/${state.currentBatch.id}/retry`, { method: "POST" });
    state.currentBatch = data.batch;
    renderBatch();
    await loadItems();
    startEvents(state.currentBatch.id);
  } catch (error) {
    window.alert(error.message);
  } finally {
    elements.retryBatch.disabled = false;
  }
}

function showDeleteConfirmation() {
  if (!state.currentBatch || elements.deleteBatch.disabled) return;
  elements.confirmLayer.hidden = false;
  elements.cancelDelete.focus();
}

function hideDeleteConfirmation() {
  elements.confirmLayer.hidden = true;
  elements.deleteBatch.focus();
}

async function deleteCurrentBatch() {
  if (!state.currentBatch) return;
  const batchId = state.currentBatch.id;
  elements.confirmDelete.disabled = true;
  try {
    await api(`/api/batches/${batchId}`, { method: "DELETE" });
    stopEvents();
    state.currentBatch = null;
    state.currentItems = [];
    elements.confirmLayer.hidden = true;
    elements.batchPanel.hidden = true;
    elements.welcomePanel.hidden = false;
    await loadBatches({ selectLatest: true });
  } catch (error) {
    window.alert(error.message);
  } finally {
    elements.confirmDelete.disabled = false;
  }
}

function modelLabel(model) {
  return ({ "v6-small": "PP-OCRv6 small", "v6-tiny": "PP-OCRv6 tiny", "v5-mobile": "PP-OCRv5 mobile" })[model] || model;
}

function bindEvents() {
  elements.chooseFiles.addEventListener("click", () => elements.fileInput.click());
  elements.fileInput.addEventListener("change", () => setFiles(elements.fileInput.files));
  ["dragenter", "dragover"].forEach((name) => elements.dropZone.addEventListener(name, (event) => { event.preventDefault(); elements.dropZone.classList.add("is-dragging"); }));
  ["dragleave", "drop"].forEach((name) => elements.dropZone.addEventListener(name, (event) => { event.preventDefault(); elements.dropZone.classList.remove("is-dragging"); }));
  elements.dropZone.addEventListener("drop", (event) => setFiles(event.dataTransfer.files));
  elements.uploadForm.addEventListener("submit", submitBatch);
  elements.batchList.addEventListener("click", (event) => { const button = event.target.closest("[data-batch-id]"); if (button) openBatch(button.dataset.batchId).catch(showFatal); });
  elements.resultsBody.addEventListener("click", (event) => { const button = event.target.closest("[data-preview-item]"); if (button) openImageViewer(button.dataset.previewItem); });
  elements.refreshBatches.addEventListener("click", () => loadBatches().catch(showFatal));
  elements.retryBatch.addEventListener("click", retryCurrentBatch);
  elements.deleteBatch.addEventListener("click", showDeleteConfirmation);
  elements.cancelDelete.addEventListener("click", hideDeleteConfirmation);
  elements.confirmDelete.addEventListener("click", deleteCurrentBatch);
  elements.confirmLayer.addEventListener("click", (event) => { if (event.target === elements.confirmLayer) hideDeleteConfirmation(); });
  elements.rotateLeft.addEventListener("click", () => rotateImage(-90));
  elements.rotateRight.addEventListener("click", () => rotateImage(90));
  elements.resetRotation.addEventListener("click", () => { state.viewerRotation = 0; updateViewerRotation(); });
  elements.closeViewer.addEventListener("click", closeImageViewer);
  elements.imageViewer.addEventListener("click", (event) => { if (event.target === elements.imageViewer) closeImageViewer(); });
  elements.previousPage.addEventListener("click", async () => { state.currentPage -= 1; await loadItems(); });
  elements.nextPage.addEventListener("click", async () => { state.currentPage += 1; await loadItems(); });
  document.addEventListener("keydown", (event) => {
    if (!elements.imageViewer.hidden) {
      if (event.key === "Escape") closeImageViewer();
      if (event.key === "ArrowLeft") rotateImage(-90);
      if (event.key === "ArrowRight") rotateImage(90);
      return;
    }
    if (event.key === "Escape" && !elements.confirmLayer.hidden) hideDeleteConfirmation();
  });
  window.addEventListener("resize", () => { if (!elements.imageViewer.hidden) updateViewerRotation(); });
  window.addEventListener("beforeunload", () => { stopEvents(); if (state.elapsedTimer) window.clearInterval(state.elapsedTimer); });
}

function showFatal(error) {
  elements.uploadError.textContent = error.message;
  elements.uploadError.hidden = false;
}

async function initialize() {
  elements.yearInput.value = String(new Date().getFullYear());
  bindEvents();
  await loadBatches();
}

initialize().catch(showFatal);
