#!/usr/bin/env node

/**
 * Node.js 版本的 PaddleOCR 命令行批处理工具
 * 基于 ppu-paddle-ocr (PP-OCRv6) + onnxruntime-node
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { PaddleOcrService, MODEL_PRESETS } from "ppu-paddle-ocr";
import sharp from "sharp";
import { processOcrResult, fillMissingNames } from "../docs/js/extractors.js";
import { formatMoney, safeFilename } from "../docs/js/image-utils.js";
import { buildSummary, makeCsv, makeMarkdown } from "../docs/js/reports.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const INPUT_DIR = path.join(ROOT, "inputs");
const OUTPUT_DIR = path.join(ROOT, "outputs_paddleocr");
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"]);

function calculateOrientationScore(text, confidence = 0) {
  if (!text || text.trim().length === 0) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const keywords = /开票|就诊|发票|病历|就医记录|门诊|金额|诊察费|治疗费|交款人|缴款人|姓名|医院|代码|流水|元|男|女|岁|日|月|年/g;
  const keywordMatches = (text.match(keywords) || []).length;
  return chineseChars + (keywordMatches * 30) + (confidence * 20);
}

async function main() {
  await fs.mkdir(INPUT_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const allFiles = await fs.readdir(INPUT_DIR).catch(() => []);
  const files = allFiles
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));

  if (files.length === 0) {
    console.log(`[提示] 输入目录 "${INPUT_DIR}" 为空，请先将发票/病历图片放入该目录。`);
    return;
  }

  console.log(`🚀 初始化 PaddleOCR (PP-OCRv6) 引擎...`);
  const ocr = new PaddleOcrService({
    model: MODEL_PRESETS["v6-small"]
  });
  await ocr.initialize();

  const targetYear = process.env.INVOICE_YEAR || "2026";
  const records = [];
  const startAll = Date.now();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const inputPath = path.join(INPUT_DIR, file);
    const itemStart = Date.now();

    const fileBuffer = await fs.readFile(inputPath);
    let arrayBuf = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);

    // 1. 尝试 0°
    let ocrResult = await ocr.recognize(arrayBuf);
    let bestScore = calculateOrientationScore(ocrResult.text, ocrResult.confidence);
    let bestAngle = 0;

    // 2. 若 0° 得分偏低，自动探测 90°, 180°, 270°
    if (bestScore < 60) {
      for (const angle of [90, 180, 270]) {
        const rotatedBuf = await sharp(inputPath).rotate(angle).toBuffer();
        const rotatedArrayBuf = rotatedBuf.buffer.slice(rotatedBuf.byteOffset, rotatedBuf.byteOffset + rotatedBuf.byteLength);
        const result = await ocr.recognize(rotatedArrayBuf);
        const score = calculateOrientationScore(result.text, result.confidence);
        if (score > bestScore) {
          bestScore = score;
          ocrResult = result;
          bestAngle = angle;
          if (bestScore >= 80) break;
        }
      }
    }

    const duration = Date.now() - itemStart;

    const record = processOcrResult(file, {
      text: ocrResult.text || "",
      rotation: bestAngle,
      confidence: ocrResult.confidence || 0
    }, targetYear);

    records.push(record);
    const typeLabel = { invoice: "发票", medical_record: "病例", unknown: "未知" }[record.kind] || "未知";
    const amountStr = record.amount !== null ? ` ${formatMoney(record.amount)}元` : "";
    const rotationStr = bestAngle ? ` [已自动旋转${bestAngle}°]` : "";
    console.log(`[${i + 1}/${files.length}] ${file}: ${record.date}${amountStr} ${record.name} (${typeLabel})${rotationStr} - ${duration}ms`);
  }

  // 批次多数表决姓名修正
  fillMissingNames(records);

  // 图像重命名与旋转保存
  const usedNames = new Set();
  for (const record of records) {
    const ext = path.extname(record.originalName).toLowerCase() || ".jpg";
    const stem = path.basename(record.originalName, ext);

    let base = "";
    if (record.skipped || record.kind === "unknown") {
      base = `unmatched-${safeFilename(stem)}`;
    } else if (record.kind === "medical_record") {
      base = `${record.date}-病例-${safeFilename(record.name)}`;
    } else {
      base = `${record.date}-${formatMoney(record.amount)}元-${safeFilename(record.name)}`;
    }

    let candidate = `${base}${ext}`;
    let count = 2;
    while (usedNames.has(candidate)) {
      candidate = `${base}-${count}${ext}`;
      count++;
    }
    usedNames.add(candidate);
    record.outputName = candidate;

    const inputPath = path.join(INPUT_DIR, record.originalName);
    const outputPath = path.join(OUTPUT_DIR, candidate);

    // 根据检测出的旋转角度将图片旋转摆正后保存
    await sharp(inputPath).rotate(record.rotation).toFile(outputPath);
  }

  // 生成报表
  const summary = buildSummary(records);
  await fs.writeFile(path.join(OUTPUT_DIR, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  await fs.writeFile(path.join(OUTPUT_DIR, "summary.csv"), makeCsv(records), "utf8");
  await fs.writeFile(path.join(OUTPUT_DIR, "summary.md"), makeMarkdown(summary), "utf8");
  await fs.writeFile(
    path.join(OUTPUT_DIR, "ocr-text.json"),
    JSON.stringify(
      records.map((r) => ({
        originalName: r.originalName,
        outputName: r.outputName,
        text: r.text
      })),
      null,
      2
    ),
    "utf8"
  );

  console.log("\n=================== 识别汇总 ===================");
  console.log(`✅ 完成：${summary.totalCount} 张发票，总金额 ${formatMoney(summary.totalAmount)} 元；${summary.medicalRecordCount} 张病历；${summary.unknownCount} 张未识别。`);
  console.log(`⏱️ 总耗时：${((Date.now() - startAll) / 1000).toFixed(1)}s`);
  console.log(`📂 输出目录：${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error("执行失败:", err);
  process.exit(1);
});
