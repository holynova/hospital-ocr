# Hospital invoice OCR interface

## Visual theme and atmosphere

This is a quiet, dense local workbench for processing medical invoices. Warm paper surfaces, dark ink typography, and restrained teal status color keep the interface legible without making private documents feel like dashboard decoration.

## Color palette and roles

- `--canvas: oklch(0.965 0.008 92)`: warm page background.
- `--surface: oklch(0.992 0.004 92)`: primary working surface.
- `--surface-muted: oklch(0.935 0.009 92)`: sidebar and secondary controls.
- `--ink: oklch(0.245 0.018 205)`: primary text.
- `--muted: oklch(0.49 0.016 205)`: secondary text.
- `--accent: oklch(0.50 0.105 174)`: progress and primary actions.
- `--danger: oklch(0.52 0.17 27)`: destructive actions and failures.

## Typography rules

Use the native macOS text stack, followed by PingFang SC for Chinese. The interface favors compact 13–15px text, tabular numerals, and a 30px product title. Chinese text keeps generous line height and no negative letter spacing.

## Component styling

Buttons use an 8px radius, clear focus rings, and a subtle press scale. Inputs and drop targets use background steps rather than decorative gradients. Tables stay flush to the workspace and use real row dividers rather than card-per-row styling.

## Layout principles

Desktop uses a 280px history rail and a flexible workspace. The main content is organized by the work sequence: upload, batch status, summary, results. Spacing follows 4, 8, 12, 16, 24, 32, and 48px.

## Depth and elevation

The sidebar and canvas use distinct background lightness. Only the upload surface and sticky action bar receive a restrained shadow. Data sections remain flat.

## Do and do not

- Keep the current batch and its progress visible.
- Use status color only where status is communicated.
- Preserve filenames and errors without silent truncation.
- Do not add charts, gradients, glass effects, or marketing copy.
- Do not hide failed items or destructive consequences.

## Responsive behavior

Below 800px the history rail becomes a horizontal batch strip above the workspace. Result rows become compact two-column blocks. All targets remain at least 40px tall and the layout supports a 375px viewport.

## Agent prompt guide

- Primary action: `oklch(0.50 0.105 174)`, white text, 8px radius, 44px height, 600 weight.
- Result table: warm white background, 1px `oklch(0.87 0.012 92)` row dividers, 13px body text, tabular numeric columns.
- Status pill: 6px radius, 12px text, tinted background derived from its semantic color, no shadow.

