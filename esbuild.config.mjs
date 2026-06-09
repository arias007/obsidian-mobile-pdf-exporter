import process from "node:process";
import builtins from "builtin-modules";
import esbuild from "esbuild";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  banner: {
    js: "/* Mobile PDF Exporter for Obsidian */"
  },
  bundle: true,
  entryPoints: ["src/main.ts"],
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins
  ],
  format: "cjs",
  loader: {
    ".otf": "base64"
  },
  logLevel: "info",
  minify: prod,
  outfile: "main.js",
  platform: "browser",
  sourcemap: prod ? false : "inline",
  target: "es2021",
  treeShaking: true
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
