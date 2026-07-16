import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist-userscript',
    lib: {
      entry: './src/userscript.js',
      name: 'LensAI',
      fileName: () => 'lensai.user.js',
      formats: ['iife'],
    },
    rollupOptions: {
      output: {
        banner: `// ==UserScript==
// @name         LensAI - Universal Data Lens
// @namespace    https://github.com/rkendel1/pocketpg
// @version      1.0.0
// @description  Inject LensAI overlay on any page - AI + SQL data lens powered by PGlite
// @author       rkendel1
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==
`,
      },
    },
    minify: false,
    sourcemap: false,
  },
});
