import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Phone cameras only work over HTTPS. `npm run dev` serves a self-signed https URL on your LAN;
// `npm run dev:local` is plain http for desktop testing on localhost.
export default defineConfig({
  base: './',
  plugins: process.env.PLAIN ? [] : [basicSsl()],
  server: { host: true },
});
