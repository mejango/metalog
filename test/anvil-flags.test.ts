import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Unpruned, Anvil writes block states to ~/.foundry/anvil/tmp and leaves them behind (gigabytes a run).
it('starts every test Anvil with pruned history', () => {
  const files = readdirSync('test', { recursive: true, encoding: 'utf8' }).filter(file => /\.(ts|mjs)$/.test(file))
  const spawners = files.filter(file => /ANVIL_BIN|spawn\(\s*['"]anvil['"]/.test(readFileSync(join('test', file), 'utf8')))
  expect(spawners).toContain(join('integration', 'fork.ts'))
  expect(spawners.filter(file => !readFileSync(join('test', file), 'utf8').includes("'--prune-history', '500'"))).toEqual([])
})
