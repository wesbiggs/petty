// Each client in VICE, with this test as its bridge: it says hello with its display, acknowledges frames, and
// draws what a random stream of text, colour, scroll and clear commands says, as the bridge's reference decoder does.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, OP, Decoder } from '../src/protocol.js';
import { CLIENTS, link, vice } from './lib/vice.js';
import { readScreen } from './lib/screen.js';

// A seeded random number below n.
function random(seed) {
  return n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff, (seed >> 8) % n);
}

for (const [name, c] of Object.entries(CLIENTS)) {
  describe(name, () => {
    let l, v;
    const { cols, rows } = c.display;
    const ref = new Decoder(cols, rows);
    const frame = async bytes => {
      ref.feed([...bytes, OP.FRAME]);
      l.write([...bytes, OP.FRAME]);
      await l.until(() => l.take(MSG.ACK), 'ACK');
    };

    before(async () => {
      l = await link();
      v = await vice(name, { port: l.port });
    });
    after(async () => { await v?.stop(); l?.close(); });

    it(`says hello as ${c.display.name}`, async () => {
      if (c.display.id === 0) await l.until(() => l.take(MSG.HELLO), 'HELLO', 60000);
      else {
        await l.until(() => l.take(MSG.HELLO_ON), 'HELLO_ON', 60000);
        await l.until(() => l.rx.length > 0, 'the display');
        assert.equal(l.rx.shift(), c.display.id);
      }
    });

    it('acknowledges a frame', async () => {
      await frame([OP.COLOR, 1, OP.CLS]);
      assert.deepEqual(l.rx, [], 'nothing else sent');
    });

    it('draws text, colours, scrolls and clears as the decoder does', async () => {
      const rnd = random(name.length * 1000 + 7);
      // the C64's colours are 0-15; the hi-res client's are a byte, the C128's a VDC attribute
      const color = () => c.display.hires || name === 'c128' ? rnd(256) : rnd(16);
      for (let f = 0; f < 60; f++) {
        const ops = [];
        while (ops.length < 200) {
          const k = rnd(100);
          if (k < 50) {
            const n = 1 + rnd(30);
            ops.push(OP.GOTO, rnd(rows), rnd(cols), OP.COLOR, color(), OP.PUT, n, ...Array.from({ length: n }, () => rnd(256)));
          } else if (k < 75) ops.push(OP.COLOR, color(), OP.REPEAT, 1 + rnd(120), rnd(256));
          else if (k < 97) {
            const top = rnd(rows - 1), bot = top + 1 + rnd(rows - 1 - top);
            ops.push(OP.COLOR, color(), OP.SCROLL, top, bot, 1 + rnd(bot - top));
          } else ops.push(OP.COLOR, color(), OP.CLS);
        }
        await frame(ops);
      }
      const screen = await readScreen(v);
      // the soft 80- and 53-column screens have one colour for each two or four characters
      assert.deepEqual(screen.differences(ref, { colors: name !== 'soft80' && name !== 'soft53' }), []);
    });
  });
}
