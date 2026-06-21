import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR requires a secure context (HTTPS) even on localhost.
// basicSsl gives us a self-signed cert for `vite dev`.
// HTTPS (self-signed) is needed for LAN access from a phone/Quest, but it
// blocks headless preview browsers and isn't needed on localhost (localhost is
// already a secure context, so WebXR works over http there). Set HTTP_PREVIEW=1
// to serve plain http for local verification.
const httpPreview = process.env.HTTP_PREVIEW === '1';

// GitHub Pages serves a project repo from /<repo>/. The deploy workflow sets
// BASE_PATH="/sat-hunt/"; local dev defaults to "/". All asset/Draco URLs are
// built from import.meta.env.BASE_URL, so they follow this automatically.
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  base,
  plugins: httpPreview ? [] : [basicSsl()],
  server: {
    https: !httpPreview,
    host: true, // expose on LAN so a phone / Quest can reach the dev server
  },
  build: {
    target: 'es2020',
    assetsInlineLimit: 0, // keep .glb/.png as real files, never inlined
  },
});
