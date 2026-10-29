// Each client in VICE against the real bridge, running a program that asks what it is drawing on (OSC 8350): the
// client's hello reaches the program, and the program's answer reaches the client's screen.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { displayReport } from '../src/protocol.js';
import { CLIENTS, ROOT, freePortPair, vice, sleep } from './lib/vice.js';
import { readScreen } from './lib/screen.js';

for (const [name, c] of Object.entries(CLIENTS)) {
  describe(`${name}: with the bridge`, () => {
    let bridge, v, log = '';
    before(async () => {
      // The bridge also listens on port + 1 (control), which may be taken: then another port.
      let port;
      for (let tries = 0; tries < 5 && !/control on/.test(log); tries++) {
        port = await freePortPair();
        log = '';
        // --mode puts the C64 client on this test's screen, as a user or a program would.
        bridge = spawn('node', [join(ROOT, 'bridge/src/bridge.js'), '--port', String(port), '--title', 'none', '--sound', 'off',
          ...(c.switches ? ['--mode', c.display.key] : []), '--',
          'sh', '-c', `node ${join(ROOT, 'bridge/scripts/ask-display.js')}; sleep 60`], { stdio: ['ignore', 'ignore', 'pipe'] });
        bridge.stderr.on('data', d => { log += d; });
        for (let t = 0; t < 100 && !/control on|EADDRINUSE/.test(log); t++) await sleep(50);
        if (!/control on/.test(log)) bridge.kill();
      }
      assert.match(log, /listening[^]*control on|control on[^]*listening/, log);
      v = await vice(name, { port });
    });
    after(async () => { await v?.stop(); bridge?.kill(); });

    it(`shows the program's answer: ${displayReport(c.display)}`, async () => {
      const want = `8350;display;${displayReport(c.display)}`;
      // (the rows joined: a 40-column screen wraps the answer)
      let lines = [];
      for (let t = 0; t < 60 && !lines.join('').includes(want); t++) {
        await sleep(500);
        lines = (await readScreen(v)).lines();
      }
      assert.ok(lines.join('').includes(want), `screen:\n${lines.join('\n')}\nbridge:\n${log}`);
      assert.match(log, new RegExp(`${c.display.name} says hello`));
    });
  });
}
