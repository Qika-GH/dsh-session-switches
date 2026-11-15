import fs from 'node:fs'

const base = 'file:///D:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js'
const mod = await import(base)
const raw = JSON.parse(fs.readFileSync(new URL('../market/index.json', import.meta.url), 'utf8'))
const indexUrl = 'https://cdn.jsdelivr.net/gh/YOUR_GITHUB_USER/dsh-session-switches@main/market/index.json'
try {
  const parsed = mod.parseMarketIndex(raw, indexUrl)
  console.log('PARSE OK; plugins:', parsed.plugins.length)
  for (const p of parsed.plugins) {
    console.log('plugin:', p.name, '| versions:', p.versions.map(v => v.version).join(','))
    for (const v of p.versions) console.log('  install:', JSON.stringify(mod.marketInstallTarget(p.name, v)))
  }
} catch (error) {
  console.error('PARSE FAIL:', error?.name, error?.message)
  process.exitCode = 1
}
