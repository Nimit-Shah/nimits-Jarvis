import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import nextVitals from "eslint-config-next/core-web-vitals";

// eslint-config-next@16 ships native flat config — no FlatCompat/@eslint/eslintrc.
// The @next/eslint-plugin-next devDep is aligned to the same 16.x version.
export default tseslint.config(
  // cli/ is a separate package with its own toolchain; scratch/ is excluded
  // from tsconfig (neither is covered by the type-checked parser config).
  globalIgnores([".next/**", "src/generated", "cli/**", "scratch/**"]),
  ...nextVitals,
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [
      ...tseslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    rules: {
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      // Downgraded from error: the codebase's established server-logging style
      // is prefixed console.log (setup.ts, composio.ts, journal.ts, ...). The
      // error level was aspirational and never enforceable (lint was broken
      // under eslint 9). Promote back to error when a structured logger lands.
      "no-console": ["warn", { allow: ["warn", "error"] }],
      // react-hooks v7 (eslint-config-next 16) ships compiler-powered rules that
      // flag pre-existing chat-component patterns (~20 hits). Downgraded to warn
      // pending a dedicated remediation pass — do NOT stack more of these.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      // Type-checked stylistic/hygiene rules: the recommendedTypeChecked +
      // stylisticTypeChecked presets ran for the first time with this upgrade
      // (~200 pre-existing violations). Downgraded to warn as the visible
      // backlog; correctness rules (no-floating-promises, no-misused-promises,
      // rules-of-hooks) stay at error. Promote back per-rule as violations
      // are paid down.
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/prefer-nullish-coalescing": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",
      "@typescript-eslint/no-empty-function": "warn",
      "@typescript-eslint/prefer-optional-chain": "warn",
      "@typescript-eslint/prefer-regexp-exec": "warn",
      "@typescript-eslint/prefer-for-of": "warn",
      "@typescript-eslint/no-base-to-string": "warn",
      "@typescript-eslint/prefer-string-starts-ends-with": "warn",
      "@typescript-eslint/unbound-method": "warn",
      "@typescript-eslint/consistent-generic-constructors": "warn",
      "@typescript-eslint/prefer-includes": "warn",
    },
  },
  {
    // Tests legitimately use `any`/unsafe access and print output.
    files: ["**/__tests__/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "no-console": "off",
    },
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
);
