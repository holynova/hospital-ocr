/**
 * 纯前端 Hospital Invoice OCR 主应用控制器
 */
import { processOcrResult, fillMissingNames } from "./extractors.js";
import { loadImage, rotateAndCorrectImage, generateUniqueOutputName, formatMoney } from "./image-utils.js";
import { buildSummary, makeCsv, makeMarkdown, triggerDownload, buildZipArchive } from "./reports.js";
import { ocrEngine } from "./ocr-engine.js";

// DOM 节点引用
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const yearInput = document.getElementById("yearInput");
const modelSelect = document.getElementById("modelSelect");
const btnPause = document.getElementById("btnPause");
const btnCancel = document.getElementById("btnCancel");
const btnStart = document.getElementById("btnStart");
const btnReset = document.getElementById("btnReset");

const progressSection = document.getElementById("progressSection");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");
const progressStatus = document.getElementById("progressStatus");

const summarySection = document.getElementById("summarySection");
const statInvoices = document.getElementById("statInvoices");
const statAmount = document.getElementById("statAmount");
const statMedical = document.getElementById("statMedical");
const statUnknown = document.getElementById("statUnknown");

const exportsToolbar = document.getElementById("exportsToolbar");
const btnDownloadZip = document.getElementById("btnDownloadZip");
const btnExportCsv = document.getElementById("btnExportCsv");
const btnExportJson = document.getElementById("btnExportJson");
const btnExportMd = document.getElementById("btnExportMd");

const resultsSection = document.getElementById("resultsSection");
const resultsTableBody = document.getElementById("resultsTableBody");

const previewModal = document.getElementById("previewModal");
const modalImg = document.getElementById("modalImg");
const modalTitle = document.getElementById("modalTitle");
const btnCloseModal = document.getElementById("btnCloseModal");

// 运行时状态
let state = {
  files: [],
  records: [],
  rotatedBlobs: new Map(), // outputName -> Blob
  previewUrls: new Map(),  // originalName -> string (Object URL)
  isProcessing: false,
  isPaused: false,
  isCancelled: false,
  summary: null
};

// 初始化事件绑定
function initApp() {
  // 设置默认年份
  yearInput.value = new Date().getFullYear().toString();

  // 拖拽事件
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFilesSelected(Array.from(e.dataTransfer.files));
    }
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFilesSelected(Array.from(e.target.files));
    }
  });

  // 按钮交互
  btnStart.addEventListener("click", startBatchProcessing);
  btnReset.addEventListener("click", resetBatch);
  btnPause.addEventListener("click", togglePause);
  btnCancel.addEventListener("click", cancelProcessing);

  // 导出交互
  btnDownloadZip.addEventListener("click", handleDownloadZip);
  btnExportCsv.addEventListener("click", () => {
    if (state.records.length) {
      triggerDownload(makeCsv(state.records), "summary.csv", "text/csv;charset=utf-8;");
    }
  });
  btnExportJson.addEventListener("click", () => {
    if (state.summary) {
      triggerDownload(JSON.stringify(state.summary, null, 2), "summary.json", "application/json");
    }
  });
  btnExportMd.addEventListener("click", () => {
    if (state.summary) {
      triggerDownload(makeMarkdown(state.summary), "summary.md", "text/markdown;charset=utf-8;");
    }
  });

  // 模态预览窗口关闭
  btnCloseModal.addEventListener("click", closeModal);
  previewModal.addEventListener("click", (e) => {
    if (e.target === previewModal) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

function handleFilesSelected(newFiles) {
  if (state.isProcessing) return;

  const validExts = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"];
  const filtered = newFiles.filter((f) => {
    const ext = f.name.includes(".") ? f.name.slice(f.name.lastIndexOf(".")).toLowerCase() : "";
    return validExts.includes(ext);
  });

  if (filtered.length === 0) {
    alert("请选择有效的图片文件 (JPG, PNG, WebP, BMP)。");
    return;
  }

  state.files = filtered;
  state.records = [];
  state.rotatedBlobs.clear();
  clearPreviewUrls();

  // 为每张图片生成本地缩略图预览
  for (const f of state.files) {
    state.previewUrls.set(f.name, URL.createObjectURL(f));
  }

  btnStart.disabled = false;
  btnStart.textContent = `开始批量识别 (${state.files.length} 张)`;
  btnReset.disabled = false;

  renderInitialTable();
  summarySection.style.display = "none";
  exportsToolbar.style.display = "none";
  progressSection.style.display = "none";
}

function renderInitialTable() {
  resultsSection.style.display = "block";
  resultsTableBody.innerHTML = "";

  state.files.forEach((file, idx) => {
    const tr = document.createElement("tr");
    tr.id = `row-${idx}`;
    const previewUrl = state.previewUrls.get(file.name);

    tr.innerHTML = `
      <td>
        <img src="${previewUrl}" class="thumb-preview" alt="预览" data-idx="${idx}" />
      </td>
      <td>${escapeHtml(file.name)}</td>
      <td><span class="pill">等待识别</span></td>
      <td>-</td>
      <td>-</td>
      <td>-</td>
      <td>-</td>
      <td>-</td>
      <td><span class="pill">排队中</span></td>
      <td>-</td>
    `;
    resultsTableBody.appendChild(tr);

    tr.querySelector(".thumb-preview").addEventListener("click", () => {
      openModal(previewUrl, file.name);
    });
  });
}

function togglePause() {
  if (!state.isProcessing) return;
  state.isPaused = !state.isPaused;
  if (state.isPaused) {
    btnPause.textContent = "继续识别";
    btnPause.classList.add("btn-primary");
    btnPause.classList.remove("btn-secondary");
    progressStatus.textContent = "⏸️ 批次识别已暂停，点击“继续识别”恢复处理。";
  } else {
    btnPause.textContent = "暂停识别";
    btnPause.classList.remove("btn-primary");
    btnPause.classList.add("btn-secondary");
    progressStatus.textContent = "▶️ 正在恢复批次处理...";
  }
}

function cancelProcessing() {
  if (!state.isProcessing) return;
  if (confirm("确定要终止当前识别任务吗？已完成的图片将保留并汇总。")) {
    state.isCancelled = true;
    state.isPaused = false;
    btnCancel.disabled = true;
    btnCancel.textContent = "正在终止...";
    progressStatus.textContent = "🛑 正在终止批次任务...";
  }
}

async function startBatchProcessing() {
  if (state.files.length === 0 || state.isProcessing) return;

  state.isProcessing = true;
  state.isPaused = false;
  state.isCancelled = false;

  btnStart.style.display = "none";
  btnPause.style.display = "inline-flex";
  btnPause.textContent = "暂停识别";
  btnPause.classList.remove("btn-primary");
  btnPause.classList.add("btn-secondary");
  btnCancel.style.display = "inline-flex";
  btnCancel.disabled = false;
  btnCancel.textContent = "终止任务";

  btnReset.disabled = true;
  dropzone.style.pointerEvents = "none";

  progressSection.style.display = "flex";
  progressFill.style.width = "0%";
  progressFill.style.background = "var(--accent)";
  progressText.textContent = `0 / ${state.files.length}`;
  progressStatus.textContent = "准备初始化 OCR 引擎...";

  const targetYear = yearInput.value.trim() || new Date().getFullYear().toString();
  if (modelSelect) {
    await ocrEngine.setModel(modelSelect.value);
  }
  const rawRecords = [];
  const tempRotatedBlobs = []; // 保存中间旋转后的 Blob

  const total = state.files.length;

  for (let i = 0; i < total; i++) {
    // 检查是否已终止
    if (state.isCancelled) {
      for (let j = i; j < total; j++) {
        const row = document.getElementById(`row-${j}`);
        if (row) {
          row.children[2].innerHTML = `<span class="pill pill-unknown">已终止</span>`;
          row.children[8].innerHTML = `<span class="pill">未处理</span>`;
        }
      }
      break;
    }

    // 检查是否处于暂停状态
    while (state.isPaused && !state.isCancelled) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (state.isCancelled) {
      for (let j = i; j < total; j++) {
        const row = document.getElementById(`row-${j}`);
        if (row) {
          row.children[2].innerHTML = `<span class="pill pill-unknown">已终止</span>`;
          row.children[8].innerHTML = `<span class="pill">未处理</span>`;
        }
      }
      break;
    }

    const file = state.files[i];
    const row = document.getElementById(`row-${i}`);
    
    // 更新行状态为识别中
    if (row) {
      row.children[2].innerHTML = `<span class="pill" style="background: var(--accent-tint); color: var(--accent);">识别中...</span>`;
    }

    progressStatus.textContent = `正在识别 [${i + 1}/${total}]: ${file.name}`;
    progressFill.style.width = `${Math.round(((i) / total) * 100)}%`;
    progressText.textContent = `${i} / ${total}`;

    try {
      // 1. OCR 识别与方向检测
      const ocrResult = await ocrEngine.recognize(file, (p) => {
        if (p.message) {
          progressStatus.textContent = `[${i + 1}/${total}] ${file.name} - ${p.message}`;
        }
      });

      // 2. 严谨字段提取与分类判定
      const record = processOcrResult(file.name, ocrResult, targetYear);
      rawRecords.push(record);

      // 3. 图像方向几何纠偏：如果原图旋转角度非 0°，自动将其旋转为正向
      const imgElem = await loadImage(file);
      const correctedBlob = await rotateAndCorrectImage(imgElem, record.rotation);
      tempRotatedBlobs.push({ originalName: file.name, blob: correctedBlob });

      // 实时更新表格单行初步结果
      updateTableRow(row, record, i);
    } catch (err) {
      console.error(`处理 ${file.name} 失败:`, err);
      const fallbackRecord = {
        originalName: file.name,
        outputName: "",
        kind: "unknown",
        date: "unknown-date",
        amount: null,
        name: "未知姓名",
        skipped: true,
        rotation: 0,
        confidence: null,
        text: ""
      };
      rawRecords.push(fallbackRecord);
      tempRotatedBlobs.push({ originalName: file.name, blob: file });
      updateTableRow(row, fallbackRecord, i);
    }
  }

  // 4. 批次全局姓名多数表决修正（对已处理部分生效）
  if (rawRecords.length > 0) {
    progressStatus.textContent = "正在执行批次姓名多数表决与报表聚合...";
    fillMissingNames(rawRecords);

    // 5. 生成无冲突的标准规范文件名并关联旋转后的 Blob
    const usedNames = new Set();
    state.rotatedBlobs.clear();

    for (let i = 0; i < rawRecords.length; i++) {
      const record = rawRecords[i];
      const outputName = generateUniqueOutputName(record, record.originalName, usedNames);
      const rotatedItem = tempRotatedBlobs[i];
      if (rotatedItem && rotatedItem.blob) {
        state.rotatedBlobs.set(outputName, rotatedItem.blob);
      }
      // 更新表格最终行结果（包含修正后的姓名与输出文件名）
      const row = document.getElementById(`row-${i}`);
      updateTableRow(row, record, i);
    }

    state.records = rawRecords;

    // 6. 汇总统计与更新看板
    state.summary = buildSummary(state.records);
    statInvoices.textContent = `${state.summary.totalCount} 张`;
    statAmount.textContent = `${formatMoney(state.summary.totalAmount)} 元`;
    statMedical.textContent = `${state.summary.medicalRecordCount} 张`;
    statUnknown.textContent = `${state.summary.unknownCount} 张`;

    summarySection.style.display = "block";
    exportsToolbar.style.display = "flex";
  }

  // 状态清理与复位按钮
  btnPause.style.display = "none";
  btnCancel.style.display = "none";
  btnStart.style.display = "inline-flex";
  btnStart.disabled = false;
  btnReset.disabled = false;
  dropzone.style.pointerEvents = "auto";
  state.isProcessing = false;
  state.isPaused = false;

  state.records.forEach((record, index) => updateTableRow(document.getElementById(`row-${index}`), record, index));

  if (state.isCancelled) {
    progressFill.style.background = "var(--warning)";
    progressStatus.textContent = `任务已终止。已处理 ${rawRecords.length} / ${total} 张图片。`;
  } else {
    progressFill.style.width = "100%";
    progressFill.style.background = "var(--accent)";
    progressText.textContent = `${total} / ${total}`;
    progressStatus.textContent = `批次识别完成！共 ${state.summary ? state.summary.totalCount : 0} 张发票，${state.summary ? state.summary.medicalRecordCount : 0} 张病历。`;
  }
}

function updateTableRow(row, record, idx) {
  if (!row) return;

  const kindBadge = getKindBadge(record.kind);
  const amountStr = record.amount !== null && record.amount !== undefined ? `${formatMoney(record.amount)} 元` : "-";
  const rotationStr = record.rotation ? `<span class="pill pill-rotation">${record.rotation}° (已摆正)</span>` : "0°";
  const outputNameStr = record.outputName ? escapeHtml(record.outputName) : "-";

  row.children[1].textContent = record.originalName;
  row.children[2].innerHTML = kindBadge;
  row.children[3].textContent = record.date;
  row.children[4].textContent = amountStr;
  row.children[5].textContent = record.name;
  row.children[6].innerHTML = rotationStr;
  row.children[7].innerHTML = `<span style="font-family: monospace; font-size: 12px;">${outputNameStr}</span>`;

  const confidenceCell = row.children[9];
  confidenceCell.replaceChildren();
  const score = document.createElement("div");
  const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "未提供";
  score.textContent = `文字：${percent(record.confidence)} / 金额行：${percent(record.amountConfidence)}`;
  score.title = "模型分数，不代表金额、姓名或日期正确的概率；金额行分数也不是金额字段正确率。";
  confidenceCell.append(score);
  const warning = document.createElement("div");
  const reasons = [...(record.reviewReasons || [])];
  if (!Number.isFinite(record.confidence)) reasons.push("模型未提供置信度");
  else if (record.confidence < 0.9) reasons.push("文字置信度低于90%");
  if (record.amountConfidence !== null && Number.isFinite(record.amountConfidence) && record.amountConfidence < 0.9) reasons.push("金额行置信度低于90%");
  warning.textContent = `${record.amountSource || ""} ${reasons.join("；") || "建议核对原图"}`;
  warning.style.color = reasons.length ? "var(--danger)" : "var(--muted)";
  confidenceCell.append(warning);
  const details = document.createElement("details");
  const label = document.createElement("summary");
  label.textContent = "查看识别文字";
  const rawText = document.createElement("pre");
  rawText.textContent = record.text || "没有识别文字";
  rawText.style.cssText = "white-space:pre-wrap;max-width:320px;max-height:220px;overflow:auto;font-size:12px;";
  details.append(label, rawText);
  confidenceCell.append(details);
  const reviewLabel = document.createElement("label");
  const reviewed = document.createElement("input");
  reviewed.type = "checkbox";
  reviewed.checked = Boolean(record.reviewed);
  reviewed.disabled = state.isProcessing;
  reviewed.addEventListener("change", () => { record.reviewed = reviewed.checked; state.summary = buildSummary(state.records); });
  reviewLabel.append(reviewed, document.createTextNode(" 已人工核对"));
  confidenceCell.append(reviewLabel);
  if (record.kind === "invoice") {
    const edit = document.createElement("button");
    edit.className = "btn btn-outline";
    edit.textContent = "修改金额";
    edit.disabled = state.isProcessing;
    edit.addEventListener("click", () => {
      edit.disabled = true;
      const form = document.createElement("form");
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0.01";
      input.step = "0.01";
      input.required = true;
      input.value = record.amount === null ? "" : String(record.amount);
      input.setAttribute("aria-label", "人工核对总金额");
      input.className = "form-input";
      input.style.width = "110px";
      const save = document.createElement("button");
      save.type = "submit";
      save.className = "btn btn-outline";
      save.textContent = "保存金额";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn-outline";
      cancel.textContent = "取消";
      cancel.addEventListener("click", () => { form.remove(); edit.disabled = false; });
      form.append(input, save, cancel);
      form.addEventListener("submit", event => {
        event.preventDefault();
        editAmount(record, input.value);
      });
      confidenceCell.append(form);
      input.focus();
    });
    confidenceCell.append(edit);
  }

  // 操作列 (单文件下载) 与缩略图摆正更新
  const actionCell = row.children[8];
  if (record.outputName && state.rotatedBlobs.has(record.outputName)) {
    const correctedBlob = state.rotatedBlobs.get(record.outputName);
    const correctedUrl = URL.createObjectURL(correctedBlob);

    // 如果方向被校正过，更新缩略图和点击弹窗为摆正后的正向图片
    const thumb = row.querySelector(".thumb-preview");
    if (thumb && record.rotation !== 0) {
      thumb.src = correctedUrl;
      thumb.onclick = () => openModal(correctedUrl, record.outputName);
    }

    actionCell.innerHTML = `<button class="btn btn-outline" style="padding: 3px 8px; font-size: 12px;" data-output="${record.outputName}">下载图片</button>`;
    actionCell.querySelector("button").addEventListener("click", () => {
      triggerDownload(correctedBlob, record.outputName);
    });
  } else {
    actionCell.innerHTML = `<span class="pill">完成</span>`;
  }
}

function editAmount(record, value) {
  if (state.isProcessing) return;
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(Number(text)) || Number(text) <= 0) {
    alert("请输入大于0、最多两位小数的金额。");
    return;
  }
  record.originalOcrAmount ??= record.amount;
  record.amount = Number(text);
  record.amountSource = "人工修改";
  record.amountConfidence = null;
  record.reviewReasons = ["金额已人工修改，仍请核对日期和姓名"];
  record.reviewed = false;
  const blobs = state.records.map(item => state.rotatedBlobs.get(item.outputName));
  const usedNames = new Set();
  state.rotatedBlobs.clear();
  state.records.forEach((item, index) => {
    generateUniqueOutputName(item, item.originalName, usedNames);
    if (blobs[index]) state.rotatedBlobs.set(item.outputName, blobs[index]);
    updateTableRow(document.getElementById(`row-${index}`), item, index);
  });
  state.summary = buildSummary(state.records);
  statAmount.textContent = `${formatMoney(state.summary.totalAmount)} 元`;
}

function getKindBadge(kind) {
  switch (kind) {
    case "invoice":
      return `<span class="pill pill-invoice">发票</span>`;
    case "medical_record":
      return `<span class="pill pill-medical">病历</span>`;
    default:
      return `<span class="pill pill-unknown">未识别 (unknown)</span>`;
  }
}

async function handleDownloadZip() {
  if (state.records.length === 0 || state.rotatedBlobs.size === 0) return;

  btnDownloadZip.disabled = true;
  const originalText = btnDownloadZip.textContent;
  btnDownloadZip.textContent = "正在打包中...";

  try {
    const zipBlob = await buildZipArchive(state.records, state.rotatedBlobs, (percent) => {
      btnDownloadZip.textContent = `打包中 (${percent}%)...`;
    });

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    triggerDownload(zipBlob, `hospital-ocr-batch-${dateStr}.zip`);
  } catch (err) {
    console.error("生成 ZIP 失败:", err);
    alert(`打包下载失败: ${err.message}`);
  } finally {
    btnDownloadZip.disabled = false;
    btnDownloadZip.textContent = originalText;
  }
}

function resetBatch() {
  if (state.isProcessing) return;

  state.files = [];
  state.records = [];
  state.rotatedBlobs.clear();
  clearPreviewUrls();
  state.summary = null;

  fileInput.value = "";
  btnStart.disabled = true;
  btnStart.textContent = "开始批量识别";
  btnReset.disabled = true;

  summarySection.style.display = "none";
  exportsToolbar.style.display = "none";
  progressSection.style.display = "none";
  resultsSection.style.display = "none";
  resultsTableBody.innerHTML = "";
}

function clearPreviewUrls() {
  for (const url of state.previewUrls.values()) {
    URL.revokeObjectURL(url);
  }
  state.previewUrls.clear();
}

function openModal(src, title) {
  modalImg.src = src;
  modalTitle.textContent = title;
  previewModal.classList.add("active");
}

function closeModal() {
  previewModal.classList.remove("active");
  modalImg.src = "";
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 启动应用
document.addEventListener("DOMContentLoaded", initApp);
