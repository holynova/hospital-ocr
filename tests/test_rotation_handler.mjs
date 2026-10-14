import fs from "fs";
import path from "path";
import sharp from "sharp";
import { PaddleOcrService, MODEL_PRESETS } from "ppu-paddle-ocr";
import { processOcrResult } from "../docs/js/extractors.js";

const testFile = path.resolve("data/batches/3144869e076245858fc6e8d0aa8e9107/originals/0001.jpg");

async function testRotations() {
  const ocr = new PaddleOcrService({
    model: MODEL_PRESETS["v6-small"]
  });
  await ocr.initialize();

  // 测试 4 个旋转角度: 0, 90, 180, 270
  for (const angle of [0, 90, 180, 270]) {
    console.log(`\n---------------- 测试图片旋转 ${angle}° ----------------`);
    const rotatedBuf = await sharp(testFile).rotate(angle).toBuffer();
    const arrayBuf = rotatedBuf.buffer.slice(rotatedBuf.byteOffset, rotatedBuf.byteOffset + rotatedBuf.byteLength);
    
    const result = await ocr.recognize(arrayBuf);
    console.log(`直接识别结果字符数: ${result.text.length}, 置信度: ${result.confidence}`);
    console.log(`前 60 字: "${result.text.slice(0, 60).replace(/\n/g, ' ')}"`);
  }
}

testRotations().catch(console.error);
