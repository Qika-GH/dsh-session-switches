import fs from 'node:fs'
const mod = await import('file:///D:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js')
const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const url = 'https://cdn.jsdelivr.net/gh/Qika-GH/dsh-session-switches@main/market/index.json'
const parsed = mod.parseMarketIndex(raw, url)
const p = parsed.plugins[0]
console.log('published index parsed OK:', p.name, p.versions[0].version)
console.log('icon:', p.icon)
console.log('install:', JSON.stringify(mod.marketInstallTarget(p.name, p.versions[0])))
