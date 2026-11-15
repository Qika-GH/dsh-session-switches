import fs from 'node:fs'
const sha = '06535e4595fccedd40a25df5f6f035bb0d97e28c'
const path = 'market/index.json'
const index = JSON.parse(fs.readFileSync(path, 'utf8'))
for (const plugin of index.plugins ?? []) {
  for (const version of plugin.versions ?? []) {
    delete version.commit
    if (version.source?.type === 'git') version.source.commit = sha
  }
}
fs.writeFileSync(path, JSON.stringify(index, null, 2) + '\n')
console.log('fixed ->', JSON.stringify(index.plugins[0].versions[0].source))
