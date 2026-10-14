import fs from "fs";
import path from "path";
import { PaddleOcrService, MODEL_PRESETS } from "ppu-paddle-ocr";
import { processOcrResult, fillMissingNames } from "../docs/js/extractors.js";

const ORIGINALS_DIR = path.resolve("data/batches/3144869e076245858fc6e8d0aa8e9107/originals");
const files = fs.readdirSync(ORIGINALS_DIR).filter(f => f.endsWith(".jpg")).sort();

async function run() {
  console.log("Initializing ppu-paddle-ocr with v6-small...");
  const ocr = new PaddleOcrService({
    model: MODEL_PRESETS["v6-small"]
  });
  await ocr.initialize();

  const records = [];
  for (const file of files) {
    const filePath = path.join(ORIGINALS_DIR, file);
    const start = Date.now();
    const buffer = fs.readFileSync(filePath);
    const result = await ocr.recognize(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    const text = result.text;
    const dur = Date.now() - start;
    
    const record = processOcrResult(file, { text, rotation: 0, confidence: result.confidence }, "2026");
    console.log(`[${file}] ${dur}ms -> 类型: ${record.kind} | 日期: ${record.date} | 金额: ${record.amount}元 | 姓名: ${record.name}`);
    records.push(record);
  }

  fillMissingNames(records);
  console.log("\n=================== 最终批次汇总 ===================");
  records.forEach(r => console.log(`${r.originalName} -> ${r.kind.padEnd(14)} | ${r.date} | ${String(r.amount).padStart(5)}元 | ${r.name}`));
}

run().catch(console.error);
