// RUN/STOP+RESTORE, and the dial through a WiFi modem. VICE can't press RESTORE from here: the test stops the
// machine, puts RUN/STOP in the KERNAL's held-key variable and jumps to the client's NMI routine, which takes an NMI
// the ACIA did not raise for RESTORE.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MSG, OP } from '../src/protocol.js';
import { BUILD, CLIENTS, hello, link, vice } from './lib/vice.js';

const STOP_KEY = 63;

async function restore(v, c) {
  const { ram } = await v.dump({ ram: [0x0318, 0x0319] });
  const nmi = ram[0] | ram[1] << 8;
  await v.monitor([`> ${c.curkey.toString(16)} ${STOP_KEY.toString(16)}`, `r pc = ${nmi.toString(16)}`]);
}

async function drawsAFrame(l) {
  l.write([OP.COLOR, 1, OP.CLS, OP.FRAME]);
  await l.until(() => l.take(MSG.ACK), 'ACK');
}

for (const [name, c] of Object.entries(CLIENTS)) {
  describe(`${name}: RUN/STOP+RESTORE`, () => {
    let l, v;
    before(async () => { l = await link(); v = await vice(name, { port: l.port }); await hello(l, c); });
    after(async () => { await v?.stop(); l?.close(); });

    it('starts the client again: it says hello anew and draws', async () => {
      await drawsAFrame(l);
      await restore(v, c);
      await hello(l, c);
      await drawsAFrame(l);
    });
  });
}

// Built by make vice-test: build/dial/petty.prg dials petty.test:6400 after an ATE0 line.
describe('c64: the dial', () => {
  const c = CLIENTS.c64;
  let l, v;
  before(async () => { l = await link({ modem: true }); v = await vice('c64', { port: l.port, prg: join(BUILD, 'dial', 'petty.prg') }); });
  after(async () => { await v?.stop(); l?.close(); });

  it('sends DIALINIT, dials, and says hello once connected', async () => {
    await hello(l, c);
    assert.deepEqual(l.lines, ['ATE0', 'ATDTPETTY.TEST:6400']);
    await drawsAFrame(l);
  });

  it('RUN/STOP+RESTORE escapes with +++, hangs up, and dials again', async () => {
    l.lines.length = 0;
    await restore(v, c);
    await hello(l, c);
    assert.deepEqual(l.lines, ['ATH', 'ATE0', 'ATDTPETTY.TEST:6400']);
    await drawsAFrame(l);
  });
});
