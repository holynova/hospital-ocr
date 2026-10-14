/**
 * 结构化统计报表生成与 JSZip 内存打包导出模块
 */
import { formatMoney } from "./image-utils.js";

/**
 * 汇总统计数据
 * @param {Array<object>} records
 * @returns {object}
 */
export function buildSummary(records) {
  const rows = records || [];
  const invoices = rows.filter((r) => r.kind === "invoice");
  const medical = rows.filter((r) => r.kind === "medical_record");
  const skipped = rows.filter((r) => r.skipped || r.kind === "unknown");

  const daily = {};
  for (const r of invoices) {
    if (!daily[r.date]) {
      daily[r.date] = { count: 0, amount: 0.0 };
    }
    daily[r.date].count += 1;
    daily[r.date].amount = Math.round((daily[r.date].amount + (r.amount || 0)) * 100) / 100;
  }

  const medicalDaily = {};
  for (const r of medical) {
    medicalDaily[r.date] = (medicalDaily[r.date] || 0) + 1;
  }

  const totalAmount = Math.round(invoices.reduce((sum, r) => sum + (r.amount || 0), 0) * 100) / 100;

  return {
    totalCount: invoices.length,
    totalAmount,
    medicalRecordCount: medical.length,
    unknownCount: skipped.length,
    daily: Object.fromEntries(Object.entries(daily).sort(([a], [b]) => a.localeCompare(b))),
    medicalDaily: Object.fromEntries(Object.entries(medicalDaily).sort(([a], [b]) => a.localeCompare(b))),
    invoices: invoices.map((r) => ({
      originalName: r.originalName,
      outputName: r.outputName,
      kind: r.kind,
      date: r.date,
      amount: r.amount,
      name: r.name,
      rotation: r.rotation
    })),
    medicalRecords: medical.map((r) => ({
      originalName: r.originalName,
      outputName: r.outputName,
      kind: r.kind,
      date: r.date,
      amount: null,
      name: r.name,
      rotation: r.rotation
    })),
    skipped: skipped.map((r) => ({
      originalName: r.originalName,
      outputName: r.outputName,
      kind: r.kind,
      date: r.date,
      amount: r.amount,
      name: r.name,
      rotation: r.rotation
    }))
  };
}

/**
 * 生成 Markdown 格式报表
 * @param {object} summary
 * @returns {string}
 */
export function makeMarkdown(summary) {
  const lines = [
    "# 发票统计",
    "",
    `- 发票张数：${summary.totalCount}`,
    `- 总金额：${formatMoney(summary.totalAmount)} 元`,
    `- 病例张数：${summary.medicalRecordCount}`,
    `- 未识别：${summary.unknownCount}`,
    "",
    "## 每日小结",
    "",
    "| 日期 | 张数 | 金额 |",
    "| --- | ---: | ---: |"
  ];

  for (const [date, item] of Object.entries(summary.daily)) {
    lines.push(`| ${date} | ${item.count} | ${formatMoney(item.amount)} 元 |`);
  }

  lines.push("", "## 发票明细", "", "| 日期 | 金额 | 姓名 | 原文件 | 输出文件 |", "| --- | ---: | --- | --- | --- |");
  for (const item of summary.invoices) {
    lines.push(`| ${item.date} | ${formatMoney(item.amount)} 元 | ${item.name} | ${item.originalName} | ${item.outputName} |`);
  }

  if (summary.medicalRecords.length > 0) {
    lines.push("", "## 病例明细", "", "| 日期 | 姓名 | 原文件 | 输出文件 | 旋转 |", "| --- | --- | --- | --- | ---: |");
    for (const item of summary.medicalRecords) {
      lines.push(`| ${item.date} | ${item.name} | ${item.originalName} | ${item.outputName} | ${item.rotation}° |`);
    }
  }

  if (summary.skipped.length > 0) {
    lines.push("", "## 未计入统计", "", "| 原文件 | 输出文件 | 原因 |", "| --- | --- | --- |");
    for (const item of summary.skipped) {
      lines.push(`| ${item.originalName} | ${item.outputName} | 模糊或未识别为发票/病例 |`);
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * 生成 CSV 格式报表
 * @param {Array<object>} records
 * @returns {string}
 */
export function makeCsv(records) {
  const rows = [["kind", "date", "amount", "name", "original_name", "output_name", "rotation"]];
  for (const record of records) {
    rows.push([
      record.kind,
      record.date,
      record.amount !== null && record.amount !== undefined ? formatMoney(record.amount) : "",
      record.name,
      record.originalName,
      record.outputName,
      record.rotation
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function csvCell(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * 触发浏览器直接下载 Blob
 * @param {Blob|string} content
 * @param {string} filename
 * @param {string} mimeType
 */
export function triggerDownload(content, filename, mimeType = "application/octet-stream") {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/**
 * 使用 JSZip 构建包含 outputs/ 旋转正向图片和 reports/ 报告的 ZIP 压缩包
 * @param {Array<object>} records
 * @param {Map<string, Blob>} imageBlobs 键为 outputName，值为正向图片 Blob
 * @param {Function} onProgress 进度回调 (0-100)
 * @returns {Promise<Blob>}
 */
export async function buildZipArchive(records, imageBlobs, onProgress) {
  if (typeof window.JSZip === "undefined") {
    throw new Error("JSZip 库未加载，无法创建压缩包");
  }

  const zip = new window.JSZip();
  const outputsFolder = zip.folder("outputs");
  const reportsFolder = zip.folder("reports");

  // 1. 添加所有正向图片
  for (const [outputName, blob] of imageBlobs.entries()) {
    outputsFolder.file(outputName, blob);
  }

  // 2. 生成并添加各类报表
  const summary = buildSummary(records);
  reportsFolder.file("summary.json", JSON.stringify(summary, null, 2));
  reportsFolder.file("summary.csv", makeCsv(records));
  reportsFolder.file("summary.md", makeMarkdown(summary));
  reportsFolder.file(
    "ocr-text.json",
    JSON.stringify(
      records.map((r) => ({
        originalName: r.originalName,
        outputName: r.outputName,
        text: r.text
      })),
      null,
      2
    )
  );

  // 3. 生成 ZIP 压缩文件
  return await zip.generateAsync(
    {
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    },
    (metadata) => {
      if (onProgress) {
        onProgress(Math.round(metadata.percent));
      }
    }
  );
}
