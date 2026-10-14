# Hospital Invoice OCR - 纯前端单批次版 (GitHub Pages)

这是一个**完全运行在用户浏览器端、零 Python 后端、基于 PaddleOCR (PP-OCRv6)** 的医疗发票与门诊病历 OCR 识别与自动归档工具。

---

## 核心特性

1. **零服务端依赖**：不需要启动任何 Python 服务、不需要配置 SQLite 或虚拟环境。可以直接托管在 GitHub Pages、Vercel 或任意静态 HTTP 服务器上。
2. **端侧深度学习 PP-OCRv6**：直接在浏览器端加载 PaddleOCR PP-OCRv6 官方模型，支持高精度中文发票与门诊病历文字识别。
3. **绝对隐私保护**：所有图片只在浏览器内存中解析和处理，100% 离线计算，不上传任何服务器或第三方接口。
4. **自动方向纠偏**：
   - 自动检测并校正图片的拍摄方向（0°/90°/180°/270°）；
   - 在导出单张图片和 ZIP 压缩包时，**自动输出摆正后的正向图片**。
5. **严谨提取，拒绝臆造**：
   - 模糊或无法明确判定的单据，如实归类为 `unknown`（未识别），文件名标记为 `unmatched-原文件名.ext`，并在报表中单独列出“未计入统计”，绝不瞎猜。
6. **批次多数表决姓名修正**：
   - 当同一个患者姓名出现 $\ge 3$ 次时，协助修复模糊病历的未识别姓名。
7. **一键导出打包**：
   - 自动生成 `YYYYMMDD-金额元-姓名.jpg` 或 `YYYYMMDD-病例-姓名.jpg`；
   - 自动生成 `summary.csv`、`summary.json`、`summary.md` 和 `ocr-text.json`；
   - 纯端侧使用 JSZip 打包并一键下载 `batch-xxxx.zip`。

---

## 启动与使用方式

### 方式 1：本地静态服务启动 (推荐)

在项目根目录下，使用任何静态 HTTP 工具启动：

```bash
# 启动本地静态服务器
npm run start:web
# 或者：python3 -m http.server 3000 --directory docs
```

打开浏览器访问：
```text
http://127.0.0.1:3000
```

### 方式 2：在线 GitHub Pages

代码推送到 `main` 分支后，直接通过 GitHub Pages 访问：
```text
https://holynova.github.io/hospital_invoice_ocr/
```

---

## 文件结构

```text
docs/
├── index.html           # 纯静态单页面应用入口
├── css/
│   └── style.css        # 现代简洁风格样式 (遵循 OKLCH 规范)
├── js/
│   ├── app.js           # 页面交互、批次流程与 UI 状态管理
│   ├── ocr-engine.js    # 浏览器端 PaddleOCR (PP-OCRv6) 引擎
│   ├── extractors.js    # 严谨规则提取器 (日期/金额/姓名/分类/多数表决)
│   ├── image-utils.js   # Canvas 旋转、EXIF 处理与正向 Blob 转换
│   ├── reports.js       # JSON/CSV/Markdown 报表生成与 JSZip 打包
│   └── paddle-ocr-bundle.js # 纯前端 PP-OCRv6 独立运行时
└── README.md            # 本说明文档
```
