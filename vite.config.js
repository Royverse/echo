import { defineConfig } from 'vite';

export default defineConfig({
  base: '/echo/',
  server: {
    port: 5173,
    host: true, // expose to local network
    open: false // do not force browser open unless requested
  }
});
