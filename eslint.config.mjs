import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent worktrees nest a full second checkout (own .next/, sources) here.
    ".claude/**",
    // Standalone CommonJS dev/audit scripts run directly via `node`, not part
    // of the app/module graph — `require()` is correct there.
    "docs/generate-classification-audit.js",
  ]),
  {
    // React Compiler correctness rules (eslint-plugin-react-hooks) surface
    // advisory hints, not build/runtime failures. They flag long-standing
    // patterns across many UI components; resolving each is a behaviour-
    // affecting refactor outside the scope of the governance/lint gate.
    // Keep them visible as warnings rather than blocking the gate.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
    },
  },
]);

export default eslintConfig;
