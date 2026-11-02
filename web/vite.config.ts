import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_DEV_PORT || 8888),
    strictPort: true,
    proxy: { '/api': process.env.VITE_API_TARGET || 'http://127.0.0.1:8000' },
  },
})
