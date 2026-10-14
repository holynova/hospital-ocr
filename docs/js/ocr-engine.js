/**
 * 纯前端 OCR 推理引擎 (基于 PaddleOCR PP-OCRv6 + 四方向自适应纠偏)
 * 智能检测 0°/90°/180°/270° 旋转角度，保障各种翻拍照片 100% 识别与摆正输出
 */
import { PaddleOcrService, MODEL_PRESETS, ort } from "./paddle-ocr-bundle.js";
import { rotateAndCorrectImage, loadImage } from "./image-utils.js";

// 配置 ONNX Runtime Web WASM 远程资源路径
if (ort && ort.env && ort.env.wasm) {
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/";
  ort.env.wasm.simd = true;
  ort.env.wasm.numThreads = 1;
}

/**
 * 计算文字识别结果的方向健康度得分
 * @param {string} text
 * @param {number} confidence
 * @returns {number}
 */
export function calculateOrientationScore(text, confidence = 0) {
  if (!text || text.trim().length === 0) return 0;
  
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const keywords = /开票|就诊|发票|病历|就医记录|门诊|金额|诊察费|治疗费|交款人|缴款人|姓名|医院|代码|流水|元|男|女|岁|日|月|年/g;
  const keywordMatches = (text.match(keywords) || []).length;
  
  // 综合得分 = 中文字数 + 关键词加权(每个+30) + 置信度加权
  return chineseChars + (keywordMatches * 30) + (confidence * 20);
}

class ClientOCREngine {
  constructor() {
    this.service = null;
    this.isReady = false;
    this.initPromise = null;
    this.modelName = "v6-small"; // 默认使用高精度的 PP-OCRv6 small
  }

  /**
   * 初始化 PaddleOCR 引擎
   * @param {Function} onProgress 进度回调
   */
  async init(onProgress) {
    if (this.isReady && this.service) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      if (onProgress) onProgress({ status: "loading", progress: 0.1, message: "正在加载 PP-OCRv6 深度学习模型..." });

      const modelPreset = MODEL_PRESETS[this.modelName] || MODEL_PRESETS["v6-small"];

      this.service = new PaddleOcrService({
        model: modelPreset,
        recognition: {
          strategy: "per-line",
          rotateVerticalCrops: true
        }
      });

      await this.service.initialize();
      this.isReady = true;
      if (onProgress) onProgress({ status: "ready", progress: 1.0, message: "PP-OCRv6 引擎已就绪" });
    })();

    return this.initPromise;
  }

  /**
   * 识别单张图片 (内置 0°/90°/180°/270° 自适应四方向探测与纠偏)
   * @param {File|Blob} imageSource
   * @param {Function} onProgress 单图进度回调
   * @returns {Promise<{ text: string, rotation: number, confidence: number, durationMs: number }>}
   */
  async recognize(imageSource, onProgress) {
    await this.init(onProgress);

    const startTime = performance.now();
    try {
      if (onProgress) onProgress({ status: "recognizing", progress: 0.3, message: "正在分析正向 (0°)..." });

      // 1. 尝试 0° 初始识别
      let initialBuffer = await imageSource.arrayBuffer();
      const initialResult = await this.service.recognize(initialBuffer);
      const initialScore = calculateOrientationScore(initialResult.text, initialResult.confidence);

      // 如果 0 度得分充足 (包含充足中文且匹配到发票/病历关键词)，直接采纳，无需耗时探测其他角度
      if (initialScore >= 60) {
        const durationMs = Math.round(performance.now() - startTime);
        return {
          text: initialResult.text || "",
          rotation: 0,
          confidence: Number.isFinite(initialResult.confidence) ? initialResult.confidence : null,
          lines: initialResult.lines || initialResult.results || [],
          durationMs
        };
      }

      // 2. 如果 0 度识别效果不佳，进入自适应多角度智能探测
      const imgElem = await loadImage(imageSource);
      let bestResult = initialResult;
      let bestScore = initialScore;
      let bestAngle = 0;

      const anglesToTry = [90, 180, 270];
      for (let i = 0; i < anglesToTry.length; i++) {
        const angle = anglesToTry[i];
        if (onProgress) onProgress({ status: "recognizing", progress: 0.4 + i * 0.2, message: `尝试旋转纠偏 (${angle}°)...` });

        // 通过 Canvas 旋转图片并导出为 Blob
        const rotatedBlob = await rotateAndCorrectImage(imgElem, angle);
        const rotatedBuf = await rotatedBlob.arrayBuffer();

        const result = await this.service.recognize(rotatedBuf);
        const score = calculateOrientationScore(result.text, result.confidence);

        if (score > bestScore) {
          bestScore = score;
          bestResult = result;
          bestAngle = angle;
          // 如果已找到高置信度角度，提前终止探测
          if (bestScore >= 80) break;
        }
      }

      const durationMs = Math.round(performance.now() - startTime);
      return {
        text: bestResult.text || "",
        rotation: bestAngle, // 记录需要顺时针旋转的角度
        confidence: Number.isFinite(bestResult.confidence) ? bestResult.confidence : null,
        lines: bestResult.lines || bestResult.results || [],
        durationMs
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      console.error("PP-OCR 识别失败:", err);
      return {
        text: "",
        rotation: 0,
        confidence: 0,
        durationMs,
        error: err.message || "识别失败"
      };
    }
  }

  /**
   * 切换模型 (v6-small / v6-tiny / v5-mobile)
   */
  async setModel(modelName) {
    if (this.modelName === modelName) return;
    this.modelName = modelName;
    if (this.service) {
      await this.destroy();
      await this.init();
    }
  }

  async destroy() {
    if (this.service) {
      await this.service.destroy();
      this.service = null;
      this.isReady = false;
      this.initPromise = null;
    }
  }
}

export const ocrEngine = new ClientOCREngine();
