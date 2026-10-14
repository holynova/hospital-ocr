# Hospital OCR Workbench

The interface is a compact, task-focused medical document workbench. Preserve batch recognition, source comparison, correction and local exports. Avoid marketing copy, decorative cards and repeated technical descriptions.

## Visual System

Use a light neutral canvas (`#f5f7f7`) and white work surfaces, ink text (`#202d31`), secondary text (`#5d6b71`) and restrained teal (`#087969`) for actions. Red communicates unresolved exceptions. Blue identifies medical records. Keep borders (`#d9e1e3`) subtle and avoid section shadows.

Use system sans-serif text. Product title is 22px, section headings 16px, data 13px and supporting labels 12px. Letter spacing remains zero; numeric values use tabular figures. Control radii are 4px, upload and image-dialog radii 6px. Use Lucide icons with accessible labels on icon-only buttons.

## Layout

One fluid workspace, capped at 1320px. Upload and settings occupy a compact band. Batch totals and export actions share a flat row. Secondary export formats and daily totals are disclosed on demand.

The results table prioritizes original document, type, date, total amount, name and review state. Do not repeat normalized output filenames or long review warnings in each row. Filters include pending, reviewed and unknown records. Search covers source/output filenames, name and date.

An inline review workspace shows the document alongside editable date, name and total amount. Confidence, warnings and raw OCR text belong here. Confirmation advances to the next unreviewed record. Keep the enlarged image in a native dialog with keyboard dismissal and focus restoration.

## Responsive and Interaction

Below 680px, document rows become a structured list and review image/fields stack vertically. Controls remain at least 42px high. Long filenames and warnings wrap within their containers. Avoid page-level horizontal scrolling.

Progress is visible during recognition; completed batch metrics replace redundant completion messages. Disable intake settings while processing. Keep search, filtering and review counts synchronized after edits. Rebuild output filenames, totals and exports from edited records. Confirm before clearing or replacing completed review work.

Confidence is a model score, not the probability a field is correct. Preserve this distinction and keep failed or unknown records visible. All real document test artifacts remain local and excluded from Git.
