// 构建时生成 public/sw.js:缓存名注入构建时间戳,发版后自动换名清旧缓存
// (脚本 URL 固定为 /sw.js,浏览器按内容差异触发更新,不依赖 Service-Worker-Allowed 头)
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stamp = 'guitarmate-' + Date.now().toString(36)

const sw = `// 自动生成(scripts/gen-sw.mjs),勿手改
const CACHE = '${stamp}'
// 预缓存路径相对 SW 作用域解析:部署在域名根或任意子目录都可用
const CORE = [
  'index.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/basic-pitch/model.json',
  'vendor/basic-pitch/group1-shard1of1.bin',
].map((u) => new URL(u, self.registration.scope).href)

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(CORE.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return
  // SPA 导航 network-first:发版后立即可得新 HTML;带哈希的静态资源缓存优先
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(new URL('index.html', self.registration.scope).href, copy))
          return res
        })
        .catch(() => caches.match(new URL('index.html', self.registration.scope).href).then((hit) => hit || new Response('离线', { status: 503 }))),
    )
    return
  }
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit
      return fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(e.request, copy))
          }
          return res
        })
        .catch(() => hit || new Response('离线且无缓存', { status: 504 }))
    }),
  )
})
`

mkdirSync(join(root, 'public'), { recursive: true })
writeFileSync(join(root, 'public', 'sw.js'), sw)
console.log(`已生成 public/sw.js(缓存名 ${stamp})`)
