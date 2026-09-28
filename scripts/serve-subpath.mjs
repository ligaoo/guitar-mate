// 验证子路径部署:把 dist 挂在 /app/ 下静态服务(模拟 GitHub Pages 项目页等场景)
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  // 只暴露 /app/** 前缀
  if (!url.startsWith('/app/')) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  let rel = url.slice('/app'.length)
  if (rel.endsWith('/')) rel += 'index.html'
  const file = normalize(join(root, rel))
  if (!file.startsWith(normalize(root))) {
    res.statusCode = 403
    res.end()
    return
  }
  try {
    const buf = await readFile(file)
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream')
    res.end(buf)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}).listen(5201, () => console.log('subpath test server: http://localhost:5201/app/'))
