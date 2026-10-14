import assert from "node:assert";
import {
  extractDate,
  extractAmount,
  extractName,
  classifyDocument,
  fillMissingNames,
  processOcrResult
} from "../docs/js/extractors.js";
import { buildSummary, makeCsv, makeMarkdown } from "../docs/js/reports.js";
import { formatMoney, generateUniqueOutputName } from "../docs/js/image-utils.js";

console.log("=== 正在运行纯前端规则与报表模块测试 ===");

// 1. 日期提取测试
assert.strictEqual(extractDate("开票日期：2024年01月02日 门诊发票"), "20240102");
assert.strictEqual(extractDate("就诊日期: 2024-01-03"), "20240103");
assert.strictEqual(extractDate("模糊文本没有日期"), null);
console.log("✔ 日期提取测试通过");

// 2. 金额提取测试 (严谨匹配，无臆造)
assert.strictEqual(extractAmount("金额合计（小写）123.45元"), 123.45);
assert.strictEqual(extractAmount("治疗费42.50元"), 42.5);
assert.strictEqual(extractAmount("（小写）10.55"), 10.55);
assert.strictEqual(extractAmount("病历就医记录无金额"), null);
console.log("✔ 金额提取测试通过");

// 3. 姓名提取测试 (黑名单与白名单)
assert.strictEqual(extractName("交款人：张三 某某医院"), "张三");
assert.strictEqual(extractName("患者姓名: 李四 男 35岁"), "李四");
assert.strictEqual(extractName("统一社会信用代码 123456789"), null);
console.log("✔ 姓名提取测试通过");

// 4. 单据分类测试 (如实汇报 unknown)
assert.strictEqual(classifyDocument("开票日期：20240102 票据代码 123 金额合计（小写）123.45", 123.45), "invoice");
assert.strictEqual(classifyDocument("就医记录 门诊病历 目前病情 复诊治疗 医师签章", null), "medical_record");
assert.strictEqual(classifyDocument("随机宣传单页风景照", null), "unknown");
console.log("✔ 单据分类测试通过");

// 5. 批次多数表决姓名修正测试
const testRecords = [
  { kind: "invoice", name: "张三", skipped: false },
  { kind: "invoice", name: "张三", skipped: false },
  { kind: "invoice", name: "张三", skipped: false },
  { kind: "medical_record", name: "未知姓名", skipped: false },
  { kind: "unknown", name: "未知姓名", skipped: true },
];
fillMissingNames(testRecords);
assert.strictEqual(testRecords[3].name, "张三");
assert.strictEqual(testRecords[4].name, "未知姓名"); // skipped 记录不被篡改
console.log("✔ 多数表决姓名修正测试通过");

// 6. 重命名与查重测试
const usedNames = new Set();
const rec1 = { kind: "invoice", date: "20240102", amount: 123.45, name: "张三", skipped: false };
const rec2 = { kind: "invoice", date: "20240102", amount: 123.45, name: "张三", skipped: false };
const rec3 = { kind: "unknown", date: "unknown-date", amount: null, name: "未知姓名", skipped: true };

const name1 = generateUniqueOutputName(rec1, "0001.jpg", usedNames);
const name2 = generateUniqueOutputName(rec2, "0002.jpg", usedNames);
const name3 = generateUniqueOutputName(rec3, "0003.jpg", usedNames);

assert.strictEqual(name1, "20240102-123.45元-张三.jpg");
assert.strictEqual(name2, "20240102-123.45元-张三-2.jpg");
assert.strictEqual(name3, "unmatched-0003.jpg");
console.log("✔ 文件重命名与防重名测试通过");

// 7. 汇总报表与 Markdown / CSV 测试
const records = [
  { kind: "invoice", date: "20240102", amount: 123.45, name: "张三", originalName: "0001.jpg", outputName: name1, rotation: 0, skipped: false, text: "xxx" },
  { kind: "invoice", date: "20240102", amount: 10.55, name: "张三", originalName: "0002.jpg", outputName: "20240102-10.55元-张三.jpg", rotation: 90, skipped: false, text: "xxx" },
  { kind: "medical_record", date: "20240102", amount: null, name: "张三", originalName: "0003.jpg", outputName: "20240102-病例-张三.jpg", rotation: 180, skipped: false, text: "xxx" },
  { kind: "unknown", date: "unknown-date", amount: null, name: "未知姓名", originalName: "0004.jpg", outputName: "unmatched-0004.jpg", rotation: 0, skipped: true, text: "xxx" }
];

const summary = buildSummary(records);
assert.strictEqual(summary.totalCount, 2);
assert.strictEqual(summary.totalAmount, 134);
assert.strictEqual(summary.medicalRecordCount, 1);
assert.strictEqual(summary.unknownCount, 1);

const csv = makeCsv(records);
assert(csv.includes("20240102,123.45,张三,0001.jpg"));

const md = makeMarkdown(summary);
assert(md.includes("- 总金额：134 元"));
assert(md.includes("未计入统计"));
console.log("✔ 报表生成与统计测试通过");

console.log("🎉 全部纯前端单测 100% 通过！");
