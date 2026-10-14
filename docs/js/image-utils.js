/**
 * 纯前端图像处理与方向几何校正模块
 * 支持读取原图、根据旋转角度生成正向图像 Blob、以及格式化无冲突文件名
 */

/**
 * 格式化金额 (与 Python format_money 一致)
 * @param {number|null} value
 * @returns {string}
 */
export function formatMoney(value) {
  if (value === null || value === undefined || isNaN(value)) return "0";
  const num = Math.round((Number(value) + 1e-9) * 100) / 100;
  return Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/0$/, "");
}

/**
 * 安全文件名清洗
 * @param {string} value
 * @returns {string}
 */
export function safeFilename(value) {
  if (!value) return "未知姓名";
  return String(value)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "")
    .slice(0, 40) || "未知姓名";
}

/**
 * 从 File / Blob 读取为 HTMLImageElement
 * @param {Blob|File} file
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(new Error(`无法加载图片: ${err}`));
    };
    img.src = url;
  });
}

/**
 * 将图片按指定角度旋转校正并导出为正向 Blob
 * @param {HTMLImageElement|ImageBitmap} img
 * @param {number} rotation 旋转角度 (0, 90, 180, 270)
 * @param {string} mimeType 导出的 MIME 类型 (默认 'image/jpeg')
 * @param {number} quality JPEG 压缩质量 (默认 0.92)
 * @returns {Promise<Blob>}
 */
export function rotateAndCorrectImage(img, rotation = 0, mimeType = "image/jpeg", quality = 0.92) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return reject(new Error("无法获取 Canvas 上下文"));
    }

    const angle = ((rotation % 360) + 360) % 360;
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    if (angle === 90 || angle === 270) {
      canvas.width = height;
      canvas.height = width;
    } else {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.save();
    // 移动原点并旋转
    switch (angle) {
      case 90:
        ctx.translate(height, 0);
        ctx.rotate((90 * Math.PI) / 180);
        break;
      case 180:
        ctx.translate(width, height);
        ctx.rotate((180 * Math.PI) / 180);
        break;
      case 270:
        ctx.translate(0, width);
        ctx.rotate((270 * Math.PI) / 180);
        break;
      default:
        // 0 度无需平移旋转
        break;
    }

    ctx.drawImage(img, 0, 0);
    ctx.restore();

    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Canvas 导出 Blob 失败"));
        }
      },
      mimeType,
      quality
    );
  });
}

/**
 * 生成规范化的输出文件名 (避免重名冲突)
 * @param {object} record 发票/病历记录
 * @param {string} originalName 原始文件名
 * @param {Set<string>} usedNames 已占用的文件名集合
 * @returns {string} 最终输出文件名
 */
export function generateUniqueOutputName(record, originalName, usedNames) {
  const ext = originalName.includes(".") ? originalName.slice(originalName.lastIndexOf(".")).toLowerCase() : ".jpg";
  const stem = originalName.replace(/\.[^/.]+$/, "");

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
  return candidate;
}
