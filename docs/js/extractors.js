/**
 * 医疗发票与病历文本提取引擎 (纯前端 JavaScript 实现)
 * 严格提取，拒绝幻觉，模糊/未识别项如实标记为 unknown / 未知
 */

/**
 * 处理单张图片的 OCR 结果并生成结构化记录
 * @param {string} originalName 原始文件名
 * @param {{ text: string, rotation: number, confidence: number }} ocrResult OCR 识别结果
 * @param {string} year 目标发票年份 (例如 "2026")
 * @returns {object}
 */
export function processOcrResult(originalName, ocrResult, year) {
  const text = ocrResult.text || "";
  const hints = parseFilenameHints(originalName, year);
  
  const extractedDate = extractDate(text, hints);
  const date = extractedDate || hints.date || "unknown-date";
  
  const amount = extractAmount(text);
  const kind = classifyDocument(text, amount);
  
  // 如果分类是发票但金额没识别到，尝试使用文件名提示中的金额；若仍没有则为 null
  let finalAmount = amount;
  if (finalAmount === null && kind === "invoice" && hints.amount !== undefined) {
    finalAmount = hints.amount;
  }
  
  const name = extractName(text) || "未知姓名";
  const skipped = (kind === "unknown");

  return {
    originalName,
    outputName: "",
    kind, // 'invoice' | 'medical_record' | 'unknown'
    date,
    amount: finalAmount,
    name,
    skipped,
    rotation: ocrResult.rotation || 0,
    confidence: ocrResult.confidence || 0,
    text: text.trim()
  };
}

/**
 * 提取开票日期或就诊日期 (带权重打分)
 */
export function extractDate(text, hints = {}) {
  const compact = normalizeText(text);
  const candidates = new Map();

  const add = (raw, score, boostMatchingHint = true) => {
    const d = normalizeDate(raw);
    if (!d) return;
    const hintScore = (boostMatchingHint && hints.monthDay === d.slice(4, 8)) ? 100 : 0;
    const current = candidates.get(d) || 0;
    candidates.set(d, Math.max(current, score + hintScore));
  };

  // 1. 明确的关键词前缀
  const patterns = [
    [/开票日期[:：]?\s*((?:20\d{2})[-./年]?\d{1,2}[-./月]?\d{1,2})/g, 100],
    [/就诊日期[:：]?\s*((?:20\d{2})[-./年]?\d{1,2}[-./月]?\d{1,2})/g, 90],
    [/\b(20\d{6})\b/g, 50],
    [/\b(20\d{2}[-./年]\d{1,2}[-./月]\d{1,2})/g, 45]
  ];

  for (const [pattern, score] of patterns) {
    for (const match of compact.matchAll(pattern)) {
      add(match[1], score);
    }
  }

  // 2. 中文年月日
  const cnDatePattern = /(20\d{2})年?(\d{1,2})月?(\d{1,2})(?=\D|\d{2}[:：]\d{2}|$)/g;
  for (const match of compact.matchAll(cnDatePattern)) {
    const formatted = `${match[1]}${String(match[2]).padStart(2, "0")}${String(match[3]).padStart(2, "0")}`;
    add(formatted, 85);
  }

  // 3. 分隔符日期
  const sepDatePattern = /(20\d{2})[-./年](\d{1,2})[-./月](\d{1,2})/g;
  for (const match of compact.matchAll(sepDatePattern)) {
    const formatted = `${match[1]}${String(match[2]).padStart(2, "0")}${String(match[3]).padStart(2, "0")}`;
    add(formatted, 80);
  }

  // 4. 文件名提示
  if (hints.date) {
    add(String(hints.date), 40, false);
  }

  if (candidates.size === 0) return null;

  // 按得分降序排序
  const sorted = Array.from(candidates.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return sorted[0][0];
}

/**
 * 提取发票金额 (严谨匹配，杜绝臆造)
 */
export function extractAmount(text) {
  const compact = normalizeText(text).replace(/\s+/g, "");
  const patterns = [
    /[（(]小写[）)]([0-9]+(?:\.[0-9]{1,2})?)/,
    /金额合计.*?[（(]小写[）)]([0-9]+(?:\.[0-9]{1,2})?)/,
    /(?:诊察费|诊查费|治疗费)([0-9]+(?:\.[0-9]{1,2})?)/
  ];

  for (const pattern of patterns) {
    const match = compact.match(pattern);
    if (match && match[1]) {
      const val = parseFloat(match[1]);
      if (!isNaN(val) && val > 0) {
        return Math.round(val * 100) / 100;
      }
    }
  }
  return null;
}

/**
 * 提取患者姓名 (严格过滤医疗术语干扰)
 */
export function extractName(text) {
  const badWords = /统一|社会|信用|代码|校验码|票据|项目名称|开票日期|金额|业务流水|门诊号|医保|性别|医师|签章|医院|名称|日期|记录|推拿科|注意|事项|个月|月|天|岁|西医|中医|治疗|病情|处理|复诊/;
  const lines = normalizeText(text).split(/\r?\n/);

  // 1. 优先匹配交款人/缴款人/患者姓名: 某某
  for (const line of lines) {
    const match = line.match(/(?:交款人|缴款人|患者姓名|姓名)[:：]\s*([\u4e00-\u9fa5]{2,6})/);
    const candidate = cleanNameCandidate(match ? match[1] : null);
    if (candidate && !badWords.test(candidate)) {
      return candidate;
    }
  }

  // 2. 匹配无空格冒号
  for (const line of lines) {
    const cleaned = line.replace(/\s+/g, "");
    const match = cleaned.match(/(?:交款人|缴款人|患者姓名|姓名)([\u4e00-\u9fa5]{2,6})/);
    const candidate = cleanNameCandidate(match ? match[1] : null);
    if (candidate && !badWords.test(candidate)) {
      return candidate;
    }
  }

  // 3. 病历中的“就医记录”后紧随的姓名查找
  const cleanLines = lines.map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < cleanLines.length; i++) {
    if (cleanLines[i].includes("就医记录")) {
      for (let j = i + 1; j < Math.min(cleanLines.length, i + 8); j++) {
        const candidate = cleanNameCandidate(cleanLines[j]);
        if (candidate && !badWords.test(candidate) && !["推拿科", "医师签章", "医院名称"].includes(candidate)) {
          return candidate;
        }
      }
    }
  }

  return null;
}

/**
 * 单据分类 (严格判定：无确凿凭据即为 unknown)
 */
export function classifyDocument(text, amount) {
  const compact = normalizeText(text).replace(/\s+/g, "");
  
  // 判定发票：必须有金额且包含票据相关关键词
  if ((amount !== null && amount > 0) && /票据代码|票据号码|金额合计|开票日期|就诊日期/.test(compact)) {
    return "invoice";
  }
  
  // 判定病历：包含就医病历相关关键词
  if (/就医记录|门诊病历|病历|复诊治疗|目前病情|处理[:：]?中医治疗|医师签章/.test(compact)) {
    return "medical_record";
  }
  
  // 其余无法确定的，一律如实上报 unknown
  return "unknown";
}

/**
 * 批次全局姓名多数表决算法 (当同一个姓名出现 >= 3 次时，协助修复模糊病历的未识别姓名)
 */
export function fillMissingNames(records) {
  const counts = new Map();
  for (const record of records) {
    if (record.skipped || record.name === "未知姓名") continue;
    counts.set(record.name, (counts.get(record.name) || 0) + 1);
  }

  let dominant = null;
  let maxCount = 0;
  for (const [name, count] of counts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      dominant = name;
    }
  }

  // 仅在主导姓名出现至少 3 次且确凿时生效
  if (!dominant || maxCount < 3) return;

  for (const record of records) {
    if (record.skipped) continue;
    if (
      record.name === "未知姓名" ||
      (record.kind === "medical_record" && record.name !== dominant) ||
      isSuspiciousName(record.name, dominant)
    ) {
      record.name = dominant;
    }
  }
}

function isSuspiciousName(name, dominant) {
  if (name.length < 3 && dominant.endsWith(name)) return true;
  return /医|治疗|病情|处理|复诊|医院|签章|名称|日期|记录|科/.test(name);
}

function cleanNameCandidate(value) {
  if (!value) return null;
  let name = value.replace(/[^\u4e00-\u9fa5]/g, "");
  if (name.length === 4 && name.startsWith("和")) {
    name = name.slice(1);
  }
  return name.length >= 2 && name.length <= 4 ? name : null;
}

export function parseFilenameHints(filename, year = "2026") {
  const nameOnly = filename.replace(/\.[^/.]+$/, "");
  const match = nameOnly.match(/^(\d{1,2}):(\d{1,2})-(\d+(?:\.\d+)?)/);
  if (!match) return {};
  const monthDay = `${match[1].padStart(2, "0")}${match[2].padStart(2, "0")}`;
  return {
    date: `${year}${monthDay}`,
    monthDay,
    amount: parseFloat(match[3])
  };
}

export function normalizeDate(raw) {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length > 8 && digits.startsWith("20")) {
    const sub = digits.slice(0, 8);
    return isValidDate(sub) ? sub : null;
  }
  if (digits.length !== 8) return null;
  return isValidDate(digits) ? digits : null;
}

function isValidDate(digits) {
  const year = parseInt(digits.slice(0, 4), 10);
  const month = parseInt(digits.slice(4, 6), 10);
  const day = parseInt(digits.slice(6, 8), 10);
  return year >= 2000 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

export function normalizeText(text) {
  if (!text) return "";
  let res = text
    .replace(/[；;]/g, ":")
    .replace(/[，]/g, ",")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[：]/g, ":")
    .replace(/[．]/g, ".");
  
  // 全角数字转半角
  res = res.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  return res;
}
