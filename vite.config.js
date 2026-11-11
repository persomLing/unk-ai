import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';

function copyExtensionAssets() {
  return {
    name: 'copy-extension-assets',
    closeBundle() {
      const files = [
        ['manifest.json', 'manifest.json'],
        ['src/content/extractor.js', 'content/extractor.js'],
        ['src/content/agent-scanner.js', 'content/agent-scanner.js'],
        ['src/content/aria-snapshot-bundle.js', 'content/aria-snapshot-bundle.js'],
        ['src/content/content.js', 'content/content.js'],
        ['src/content/page-selection.js', 'content/page-selection.js'],
        ['src/content/figure-picker.js', 'content/figure-picker.js'],
        ['_locales/zh_CN/messages.json', '_locales/zh_CN/messages.json'],
      ];
      for (const size of [16, 32, 48, 128]) {
        files.push([`icons/icon-${size}.png`, `icons/icon-${size}.png`]);
      }
      for (const [source, destination] of files) {
        mkdirSync(resolve(import.meta.dirname, 'dist', destination, '..'), { recursive: true });
        copyFileSync(resolve(import.meta.dirname, source), resolve(import.meta.dirname, 'dist', destination));
      }
      for (const directory of ['cmaps', 'standard_fonts']) {
        cpSync(
          resolve(import.meta.dirname, 'node_modules/pdfjs-dist', directory),
          resolve(import.meta.dirname, 'dist/pdfjs', directory),
          { recursive: true },
        );
      }
      mkdirSync(resolve(import.meta.dirname, 'dist/pdfjs'), { recursive: true });
      copyFileSync(
        resolve(import.meta.dirname, 'node_modules/pdfjs-dist/LICENSE'),
        resolve(import.meta.dirname, 'dist/pdfjs/LICENSE'),
      );
    },
  };
}

export default defineConfig({
  plugins: [copyExtensionAssets()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, 'src/sidepanel/index.html'),
        'sidepanel-theme-boot': resolve(import.meta.dirname, 'src/sidepanel/theme-boot.js'),
        options: resolve(import.meta.dirname, 'src/options/index.html'),
        'service-worker': resolve(import.meta.dirname, 'src/background/service-worker.js'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'service-worker'
            ? 'service-worker.js'
            : chunk.name === 'sidepanel-theme-boot'
              ? 'src/sidepanel/theme-boot.js'
              : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
