import fs from "fs";
import path from "path";
import sharp from "sharp";
import { PaddleOcrService, MODEL_PRESETS } from "ppu-paddle-ocr";
import { processOcrResult } from "../docs/js/extractors.js";

const testFile = path.resolve("data/batches/3144869e076245858fc6e8d0aa8e9107/originals/0001.jpg");

function calculateOrientationScore(text, confidence) {
  if (!text || text.trim().length === 0) return 0;
  
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const keywords = /开票|就诊|发票|病历|就医记录|门诊|金额|诊察费|治疗费|交款人|缴款人|姓名|医院|代码|流水|元/g;
  const keywordMatches = (text.match(keywords) || []).length;
  
  // 综合健康分 = 中文字数 + 关键词加权(每个+30) + 置信度加权
  const score = chineseChars + (keywordMatches * 30) + (confidence * 20);
  return score;
}

async function recognizeWithAutoOrientation(ocr, imageBuffer) {
  const angles = [0, 90, 180, 270];
  let bestResult = null;
  let bestScore = -1;
  let bestAngle = 0;

  // 1. 先尝试 0 度
  const initialResult = await ocr.recognize(imageBuffer);
  const initialScore = calculateOrientationScore(initialResult.text, initialResult.confidence);
  
  // 如果 0 度得分很高（包含大量中文且有明确关键词），直接返回，无需尝试其他角度
  if (initialScore >= 60) {
    return {
      text: initialResult.text,
      rotation: 0,
      confidence: initialResult.confidence,
      score: initialScore
    };
  }

  bestResult = initialResult;
  bestScore = initialScore;
  bestAngle = 0;

  // 2. 如果 0 度识别很差，依次尝试 90, 180, 270
  for (const angle of [90, 180, 270]) {
    const rotated = await sharp(Buffer.from(imageBuffer)).rotate(angle).toBuffer();
    const rotatedArrayBuf = rotated.buffer.slice(rotated.byteOffset, rotated.byteOffset + rotated.byteLength);
    
    const result = await ocr.recognize(rotatedArrayBuf);
    const score = calculateOrientationScore(result.text, result.confidence);
    
    if (score > bestScore) {
      bestScore = score;
      bestResult = result;
      bestAngle = angle;
      // 如果已找到极佳的角度，提前终止
      if (bestScore >= 80) break;
    }
  }

  return {
    text: bestResult.text,
    rotation: bestAngle, // 需要顺时针旋转 bestAngle 度才能摆正
    confidence: bestResult.confidence,
    score: bestScore
  };
}

async function test() {
  const ocr = new PaddleOcrService({ model: MODEL_PRESETS["v6-small"] });
  await ocr.initialize();

  for (const inputAngle of [0, 90, 180, 270]) {
    console.log(`\n================== 输入一张人为旋转了 ${inputAngle}° 的图片 ==================`);
    const rotated = await sharp(testFile).rotate(inputAngle).toBuffer();
    const arrayBuf = rotated.buffer.slice(rotated.byteOffset, rotated.byteOffset + rotated.byteLength);

    const start = Date.now();
    const res = await recognizeWithAutoOrientation(ocr, arrayBuf);
    const dur = Date.now() - start;

    console.log(`⏱️ 自动纠偏耗时: ${dur}ms`);
    console.log(`🎯 检测出的最佳纠正角度: ${res.rotation}° (得分: ${res.score})`);
    console.log(`📄 识别文字片段: "${res.text.slice(0, 50).replace(/\n/g, ' ')}"`);
    
    const record = processOcrResult("test.jpg", res, "2026");
    console.log(`✅ 最终解析结果: 类型=${record.kind}, 日期=${record.date}, 姓名=${record.name}`);
  }
}

test().catch(console.error);
