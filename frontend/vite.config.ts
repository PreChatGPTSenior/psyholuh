import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    server: {
      host: 'localhost',
      proxy: { '/api': { target: env.PSYHOLUH_API_ORIGIN || 'http://127.0.0.1:8000' } },
    },
  }
})
