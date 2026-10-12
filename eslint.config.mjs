import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Design §11.4: components use semantic tokens only. No raw hex, no Tailwind palette colors.
const RAW_HEX = String.raw`#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b`;
const PALETTE_CLASS = String.raw`\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|placeholder|decoration|shadow|accent|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b`;
const noRawColors = [
  "error",
  { selector: `Literal[value=/${RAW_HEX}/]`, message: "Use a semantic token (tokens.css), not a raw hex color." },
  { selector: `TemplateElement[value.raw=/${RAW_HEX}/]`, message: "Use a semantic token (tokens.css), not a raw hex color." },
  { selector: `Literal[value=/${PALETTE_CLASS}/]`, message: "Use a semantic Tailwind token (bg-surface, text-ink-2, …), not a palette color." },
  { selector: `TemplateElement[value.raw=/${PALETTE_CLASS}/]`, message: "Use a semantic Tailwind token, not a palette color." },
];

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: ["node_modules/**", ".next/**", ".next-e2e/**", "data/**", "lib/generated/**", "coverage/**", "playwright-report/**", "test-results/**", "next-env.d.ts"],
  },
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": noRawColors },
  },
  {
    // Backend spec §3: lib/domain is pure. No Prisma, no Next.js, no network.
    files: ["lib/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@prisma/*", "**/generated/**", "**/db", "**/lib/db"], message: "lib/domain must not touch the database." },
            { group: ["next", "next/*", "react", "react-dom"], message: "lib/domain must stay framework-free." },
          ],
        },
      ],
      "no-restricted-globals": ["error", { name: "fetch", message: "lib/domain must not make network calls; inject them." }],
    },
  },
];

export default config;
