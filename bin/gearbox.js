#!/usr/bin/env node
import { spawnSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const bunCheck = spawnSync('bun', ['--version'], { encoding: 'utf8' })
if (bunCheck.error) {
  console.error('Gearbox requires Bun. Install it: https://bun.sh')
  process.exit(1)
}

const entry = resolve(__dirname, '../src/cli.tsx')
const result = spawnSync('bun', [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
process.exit(result.status ?? 1)
