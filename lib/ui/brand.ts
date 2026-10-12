// The two colors the web app manifest and browser chrome need as literal values (they cannot read CSS
// variables). They mirror app/tokens.css: --concrete-100 (day background) and --signal-600 (Interstate blue).
export const BRAND = {
  background: "#eef1f2",
  theme: "#1565c0",
} as const;
