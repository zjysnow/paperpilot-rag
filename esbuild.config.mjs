import esbuild from "esbuild";

const production = process.argv[2] === "production";

await esbuild.build({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2018",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  logLevel: "info",
});
