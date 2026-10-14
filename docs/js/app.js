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
  updateIcons();
  document.getElementById("searchInput").addEventListener("input", filterResults);
  document.getElementById("reviewFilter").addEventListener("change", filterResults);
  document.getElementById("reviewForm").addEventListener("submit", saveReview);
  document.getElementById("closeReview").addEventListener("click", closeReview);
  document.getElementById("reviewPrevious").addEventListener("click", () => openReview(reviewIndex - 1));
  document.getElementById("reviewNext").addEventListener("click", () => openReview(reviewIndex + 1));
  document.getElementById("reviewImageButton").addEventListener("click", () => openModal(reviewUrl, state.records[reviewIndex]?.originalName || "原图"));
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
      document.querySelector(".export-menu").open = false;
    }
  });
  btnExportJson.addEventListener("click", () => {
    if (state.summary) {
      triggerDownload(JSON.stringify(state.summary, null, 2), "summary.json", "application/json");
      document.querySelector(".export-menu").open = false;
    }
  });
  btnExportMd.addEventListener("click", () => {
    if (state.summary) {
      triggerDownload(makeMarkdown(state.summary), "summary.md", "text/markdown;charset=utf-8;");
      document.querySelector(".export-menu").open = false;
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

  if (state.records.length && !confirm("替换当前批次？请先下载需要保留的结果。")) return;
  closeReview();
  document.getElementById("searchInput").value = "";
  document.getElementById("reviewFilter").value = "all";
  state.files = filtered;
  state.summary = null;
  document.getElementById("uploadLabel").textContent = `已选择 ${filtered.length} 张单据`;
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
  filterResults();
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
        <button class="thumb-button" aria-label="查看单据原图"><img src="${previewUrl}" class="thumb-preview" alt="单据缩略图" data-idx="${idx}" /></button>
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

    tr.querySelector(".thumb-button").onclick = () => {
      openModal(previewUrl, file.name);
    };
  });
}

function togglePause() {
  if (!state.isProcessing) return;
  state.isPaused = !state.isPaused;
  if (state.isPaused) {
    btnPause.textContent = "继续识别";
    btnPause.classList.add("btn-primary");
    btnPause.classList.remove("btn-secondary");
    progressStatus.textContent = "识别已暂停";
  } else {
    btnPause.textContent = "暂停识别";
    btnPause.classList.remove("btn-primary");
    btnPause.classList.add("btn-secondary");
    progressStatus.textContent = "正在继续识别...";
  }
}

function cancelProcessing() {
  if (!state.isProcessing) return;
  if (confirm("确定要终止当前识别任务吗？已完成的图片将保留并汇总。")) {
    state.isCancelled = true;
    state.isPaused = false;
    btnCancel.disabled = true;
    btnCancel.textContent = "正在终止...";
    progressStatus.textContent = "正在终止任务...";
  }
}

async function startBatchProcessing() {
  if (state.files.length === 0 || state.isProcessing) return;
  if (state.records.length && !confirm("重新识别会替换当前结果和人工修改，是否继续？")) return;

  closeReview();
  state.records = [];
  state.summary = null;
  state.rotatedBlobs.clear();
  summarySection.style.display = "none";
  renderInitialTable();
  state.isProcessing = true;
  dropzone.disabled = true;
  yearInput.disabled = true;
  modelSelect.disabled = true;
  btnPause.hidden = false;
  btnCancel.hidden = false;
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

    summarySection.style.display = "grid";
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
  dropzone.disabled = false;
  yearInput.disabled = false;
  modelSelect.disabled = false;
  btnPause.hidden = true;
  btnCancel.hidden = true;

  if (state.records.length) refreshBatch();

  if (state.isCancelled) {
    progressFill.style.background = "var(--warning)";
    progressStatus.textContent = `任务已终止。已处理 ${rawRecords.length} / ${total} 张图片。`;
  } else {
    progressFill.style.width = "100%";
    progressFill.style.background = "var(--accent)";
    progressText.textContent = `${total} / ${total}`;
    progressStatus.textContent = "识别完成";
    progressSection.style.display = "none";
    btnStart.textContent = "重新识别";
  }
}

function updateTableRow(row, record, idx) {
  if (!row) return;
  row.children[1].innerHTML = `<span class="document-title">${escapeHtml(record.originalName)}</span>${record.rotation ? `<span class="rotation-label">已旋转 ${record.rotation}°</span>` : ""}`;
  row.children[2].innerHTML = getKindBadge(record.kind);
  row.children[3].textContent = record.date.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  row.children[4].textContent = record.amount == null ? "—" : formatMoney(record.amount);
  row.children[5].textContent = record.name;
  const cell = row.children[9];
  cell.innerHTML = `<div class="review-cell"><span class="confidence-value" title="文字置信度，非字段正确率">${formatConfidence(record.confidence)}</span><button class="review-link ${!record.reviewed && reviewWarnings(record).length ? "needs-attention" : ""}" ${state.isProcessing ? "disabled" : ""}>${record.reviewed ? "已核对" : reviewWarnings(record).length ? "需关注 · 核对" : "待核对"}</button></div>`;
  cell.querySelector("button").addEventListener("click", () => openReview(idx));
  const actionCell = row.children[8];
  actionCell.replaceChildren();
  const blob = state.rotatedBlobs.get(record.outputName);
  if (blob) {
    const download = document.createElement("button");
    download.className = "btn btn-secondary icon-btn";
    download.setAttribute("aria-label", "下载此单据");
    download.title = "下载此单据";
    download.innerHTML = '<i data-lucide="download" aria-hidden="true"></i>';
    download.addEventListener("click", () => triggerDownload(blob, record.outputName));
    actionCell.append(download);
  }
  const preview = row.querySelector(".thumb-button");
  if (preview) preview.onclick = () => state.isProcessing ? openModal(state.previewUrls.get(record.originalName), record.originalName) : openReview(idx);
  updateIcons(row);
}

function formatConfidence(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "未提供";
}

function reviewWarnings(record) {
  const reasons = [...(record.reviewReasons || [])];
  if (!Number.isFinite(record.confidence)) reasons.push("没有文字置信度");
  else if (record.confidence < 0.9) reasons.push("文字置信度低于90%");
  if (Number.isFinite(record.amountConfidence) && record.amountConfidence < 0.9) reasons.push("金额行置信度低于90%");
  if (record.name === "未知姓名") reasons.push("姓名未识别");
  if (record.date === "unknown-date") reasons.push("日期未识别");
  if (record.kind === "unknown") reasons.push("单据类型未识别");
  return reasons;
}

function updateIcons(root = document) {
  if (window.lucide) window.lucide.createIcons({ root });
}

function refreshBatch() {
  const blobs = state.records.map(item => state.rotatedBlobs.get(item.outputName));
  state.rotatedBlobs.clear();
  const usedNames = new Set();
  state.records.forEach((item, index) => {
    generateUniqueOutputName(item, item.originalName, usedNames);
    if (blobs[index]) state.rotatedBlobs.set(item.outputName, blobs[index]);
    updateTableRow(document.getElementById(`row-${index}`), item, index);
  });
  state.summary = buildSummary(state.records);
  statInvoices.textContent = `${state.summary.totalCount} 张`;
  statAmount.textContent = `${formatMoney(state.summary.totalAmount)} 元`;
  statMedical.textContent = `${state.summary.medicalRecordCount} 张`;
  statUnknown.textContent = `${state.summary.unknownCount} 张`;
  const daily = document.getElementById("dailyRows");
  daily.replaceChildren();
  for (const [date, item] of Object.entries(state.summary.daily)) {
    const row = document.createElement("span");
    row.className = "daily-item";
    row.textContent = `${date.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")} · ${item.count} 张 · ${formatMoney(item.amount)} 元`;
    daily.append(row);
  }
  for (const [date, count] of Object.entries(state.summary.medicalDaily)) {
    const row = document.createElement("span");
    row.className = "daily-item";
    row.textContent = `${date.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")} · 病历 ${count} 张`;
    daily.append(row);
  }
  filterResults();
}

function filterResults() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const filter = document.getElementById("reviewFilter").value;
  let shown = 0;
  state.files.forEach((file, index) => {
    const record = state.records[index];
    const text = record ? `${record.originalName} ${record.outputName} ${record.name} ${record.date} ${record.date.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")}` : file.name;
    const matchesFilter = filter === "all" || (record && (filter === "pending" ? !record.reviewed : filter === "reviewed" ? record.reviewed : record.kind === "unknown"));
    const visible = matchesFilter && text.toLowerCase().includes(query);
    document.getElementById(`row-${index}`).hidden = !visible;
    if (visible) shown++;
  });
  const pending = state.records.filter(r => !r.reviewed).length;
  document.getElementById("reviewCount").textContent = state.records.length ? `${shown} / ${state.files.length} 张 · 待核对 ${pending} 张` : `${state.files.length} 张待识别`;
  document.getElementById("filterEmpty").hidden = shown > 0;
}

let reviewIndex = -1;
let reviewUrl = null;
function openReview(index) {
  const record = state.records[index];
  if (!record || state.isProcessing) return;
  reviewIndex = index;
  const panel = document.getElementById("reviewPanel");
  panel.hidden = false;
  if (reviewUrl) URL.revokeObjectURL(reviewUrl);
  const blob = state.rotatedBlobs.get(record.outputName) || state.files[index];
  reviewUrl = URL.createObjectURL(blob);
  document.getElementById("reviewImage").src = reviewUrl;
  document.getElementById("reviewFilename").textContent = record.originalName;
  document.getElementById("reviewPosition").textContent = `${index + 1} / ${state.records.length}`;
  document.getElementById("reviewPrevious").disabled = index === 0;
  document.getElementById("reviewNext").disabled = index === state.records.length - 1;
  document.getElementById("textScore").textContent = formatConfidence(record.confidence);
  document.getElementById("amountScore").textContent = formatConfidence(record.amountConfidence);
  document.getElementById("reviewWarning").textContent = reviewWarnings(record).join("；");
  document.getElementById("reviewDate").value = record.date.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  document.getElementById("reviewName").value = record.name === "未知姓名" ? "" : record.name;
  document.getElementById("reviewAmount").value = record.amount ?? "";
  document.getElementById("reviewAmount").required = record.kind === "invoice";
  document.getElementById("reviewAmountLabel").hidden = record.kind !== "invoice";
  document.getElementById("reviewOutput").textContent = `输出：${record.outputName}${record.amountSource ? " · 金额来源：" + record.amountSource : ""}`;
  document.getElementById("reviewRawText").textContent = record.text || "没有识别文字";
  document.getElementById("reviewError").textContent = "";
  document.getElementById("reviewError").style.color = "";
  document.querySelector(".ocr-disclosure").open = false;
  panel.scrollIntoView({ behavior: "auto", block: "nearest" });
  document.getElementById("reviewDate").focus({preventScroll:true});
}

function closeReview() {
  document.getElementById("reviewPanel").hidden = true;
  if (reviewUrl) URL.revokeObjectURL(reviewUrl);
  reviewUrl = null;
  reviewIndex = -1;
  document.getElementById("reviewImage").removeAttribute("src");
}

function saveReview(event) {
  event.preventDefault();
  const record = state.records[reviewIndex];
  if (!record || state.isProcessing) return;
  const date = document.getElementById("reviewDate").value.replaceAll("-", "");
  const name = document.getElementById("reviewName").value.trim();
  const amount = document.getElementById("reviewAmount").value.trim();
  if (!/^\d{8}$/.test(date) || !name || (record.kind === "invoice" && (!/^\d+(?:\.\d{1,2})?$/.test(amount) || !Number.isFinite(Number(amount)) || Number(amount) <= 0))) {
    document.getElementById("reviewError").textContent = "请填写有效的日期、姓名和总金额。";
    return;
  }
  if (record.kind === "invoice" && Number(amount) !== record.amount) {
    record.originalOcrAmount ??= record.amount;
    record.amount = Number(amount);
    record.amountSource = "人工修改";
    record.amountConfidence = null;
    record.reviewReasons = [];
  }
  record.date = date;
  record.name = name;
  const confirm = event.submitter?.name === "confirm";
  record.reviewed = confirm;
  const current = reviewIndex;
  refreshBatch();
  if (confirm) {
    const next = state.records.findIndex((item,index) => index > current && !item.reviewed);
    const remaining = next >= 0 ? next : state.records.findIndex(item => !item.reviewed);
    if (remaining >= 0 && remaining !== current) openReview(remaining);
    else closeReview();
  } else {
    openReview(current);
    document.getElementById("reviewError").textContent = "修改已保存；确认核对后可继续下一张。";
    document.getElementById("reviewError").style.color = "var(--accent)";
  }
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
  const originalText = btnDownloadZip.innerHTML;
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
    btnDownloadZip.innerHTML = originalText;
  }
}

function resetBatch() {
  if (state.isProcessing) return;
  if (state.records.length && !confirm("清空当前批次？请先下载需要保留的结果。")) return;
  closeReview();

  state.files = [];
  state.records = [];
  state.rotatedBlobs.clear();
  clearPreviewUrls();
  state.summary = null;
  document.getElementById("uploadLabel").textContent = "选择或拖入单据图片";
  document.getElementById("searchInput").value = "";
  document.getElementById("reviewFilter").value = "all";

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
  if (!previewModal.open) previewModal.showModal();
}

function closeModal() {
  previewModal.close();
  modalImg.removeAttribute("src");
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 启动应用
document.addEventListener("DOMContentLoaded", initApp);
