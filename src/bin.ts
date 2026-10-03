#!/usr/bin/env node
// The installed command (`cubiclark`, package.json `bin`). It imports nothing that loads a Node
// built-in before NO_COLOR and FORCE_COLOR are settled: Node warns about the pair while it *loads*
// node:util, node:http or node:assert, before any code of cli.ts runs and before a `warning` listener
// could be installed (measured on Node 26). So the variables are settled here, and the program is
// imported afterwards. `node dist/cli.js` still runs the same program, without this first step.

import { settleColorEnv } from './color-env.js'

settleColorEnv(process.env)
const { main } = await import('./cli.js')
await main()
