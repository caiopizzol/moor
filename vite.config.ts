import { defineConfig } from "vite-plus";

export default defineConfig({
  defaultPackage: "apps/web",
  fmt: {},
  staged: {
    "*": ["vp check --fix", () => "bun run typecheck"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
