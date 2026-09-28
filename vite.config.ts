import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 相对路径:构建产物可部署在任意路径(域名根/子目录/GitHub Pages 项目页)
  base: './',
  // BP Worker 内部有动态 import(按需加载 TF.js),必须用 es 格式支持代码分割
  worker: {
    format: 'es',
  },
})
