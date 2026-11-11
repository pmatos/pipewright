/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served from https://pmatos.github.io/pipewright/ on GitHub Pages.
export default defineConfig({
  base: process.env.PIPEWRIGHT_BASE ?? '/pipewright/',
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
