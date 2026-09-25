// Compila el widget embebible: widget-src/widget.js (ESM, importa
// lib/chat-protocol.ts) → public/widget/widget.js (IIFE, ES2017, un solo
// archivo que se pega en la web del cliente). Corre en `pnpm build` (prebuild)
// y a mano con `pnpm build:widget`. El artefacto se versiona igual para que
// `next dev` lo sirva sin build previo.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [path.join(root, "widget-src", "widget.js")],
  outfile: path.join(root, "public", "widget", "widget.js"),
  bundle: true,
  format: "iife",
  target: ["es2017", "safari12"],
  minify: false,
  legalComments: "none",
  banner: { js: "/* Intellix widget — generado desde widget-src/ (no editar a mano; pnpm build:widget) */" },
  logLevel: "info",
});
