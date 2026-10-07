// Game hardware for a program running in the bridge's terminal: hardware
// sprites (OSC 8348) and the SID (OSC 8349) on the C64 text client. Where
// say and play (OSC 8347) are about sound files, these are about the machine:
// a program that runs on the host and uses the C64 as its screen, keyboard,
// sprite chip and sound chip. (The C64 text and hi-res clients.)
//
// OSC 8348: sprites. Positions are pixels of the 320x200 text screen (0, 0
// is the top left of cell 0, 0; the VIC's own coordinates are 24 and 50 more).
//
//   def ; SLOT ; BASE64     a shape: 63 bytes, 3 a row, 21 rows, the top left pixel
//                           the top bit of byte 0. SLOT 0-63. Shapes are kept in the C64.
//   set ; N ; SLOT ; X ; Y ; COLOR [; FLAGS]
//                           show sprite N (0-7) at X, Y with that shape and colour (0-15).
//                           FLAGS: letters x (wide), y (tall), m (multicolour), b (behind
//                           the text). Sprites are in front of higher numbers. Sending
//                           what is already there sends nothing.
//   hide ; N
//   glide ; N ; DX ; DY ; FRAMES
//                           move by DX, DY pixels (-128 to 127) a video frame (50 or 60 a
//                           second) for FRAMES frames (1-255), on the C64: a walk or a shot
//                           costs one command. The sprite is then where it would be: a
//                           `set` there afterwards sends nothing.
//   mc ; C1 ; C2            the two colours multicolour sprites share
//   sync ; TAG              the bridge writes ESC ] 8348 ; sync ; TAG BEL to the program's
//                           input once the glides have ended (or, if the C64 does not
//                           say so, the time they should take is up)
//
// OSC 8349: the SID. A script is a list of records [n, (register, value) * n,
// delay]: write n registers, then wait `delay` frames before the next record
// (0: the next one at once). n = 255 ends it, n = 254 loops to the start (or to
// the last record marker, n = 253, which does nothing). Uploaded once, played by
// number on one of four channels, each with a mask of the registers its script
// may write, so music on two voices and an effect on the third leave each other
// alone. Time is in frames, so tempo follows the machine (PAL or NTSC).
//
//   def ; ID ; BASE64       a script, as above
//   play ; CH ; ID [; VOICES]
//                           start it on channel 0-3 (restarting it if that was playing).
//                           VOICES: where it may write, joined by +: 1 2 3 (a voice's 7
//                           registers), f (the filter), vol (the volume register), all
//                           (the default), or a number for the 25 register bits
//   stop ; CH               (or all) stop, with the gates down
//   w ; REG ; VAL [; REG ; VAL ...]
//                           write registers now, unmasked
//   reset                   stop everything, every register 0
//
// The state is the bridge's too: a client that restarts, or a reconnect, gets
// the shapes, sprites, scripts and looping music again.

import { OP, SPR, SPRITE_SLOTS, encodeSprDef, encodeSpr, encodeGlide, encodeSidW, encodeSidPlay, encodeSidStop, encodePoke } from './protocol.js';

export const SCRIPT_BASE = 0x9000; // where the C64 clients have room for scripts (the hi-res one's ring ends there)
export const SCRIPT_END = 0xC000;
const SCREEN_X = 24, SCREEN_Y = 50; // the VIC's coordinates of the text's top left
const MAX_QUEUE = 32768; // bytes held for a client that is not taking them
const FLAG = { x: SPR.WIDE, y: SPR.TALL, m: SPR.MULTI, b: SPR.BEHIND };
const VOICE_MASK = { 1: 0x7F, 2: 0x7F << 7, 3: 0x7F << 14, f: 0x7 << 21, vol: 1 << 24 };
const ALL = 0x1FFFFFF;
const GLIDE_SLACK_MS = 400;

const int = (v, lo, hi, what) => {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isInteger(n) || n < lo || n > hi) throw new Error(`${what} must be a whole number ${lo}-${hi}, not ${JSON.stringify(v)}`);
  return n;
};

// A script from the program (see above) as the C64 reads it, for `base`: the
// loop and the loop marker become an address. Throws if it is not well formed.
// Returns { bytes, loops }.
export function compileScript(src, base = 0) {
  const out = [];
  let loopAt = 0, i = 0, ended = false, loops = false;
  while (i < src.length) {
    const n = src[i];
    if (n === 0xFD) { loopAt = out.length; i++; continue; }
    if (n === 0xFF) { out.push(0xFF); ended = true; break; }
    if (n === 0xFE) {
      const to = base + loopAt;
      loops = true;
      out.push(0xFE, to & 0xFF, to >> 8);
      ended = true;
      break;
    }
    const len = 2 + 2 * n;
    if (i + len > src.length) throw new Error('script ends inside a record');
    for (let k = 0; k < len; k++) out.push(src[i + k]);
    i += len;
  }
  if (!ended) out.push(0xFF);
  return { bytes: Uint8Array.from(out), loops };
}

export function parseVoices(text) {
  if (text === undefined || text === '' || text === 'all') return ALL;
  if (/^(0x[0-9a-f]+|\d{3,})$/i.test(text)) return Number(text) & ALL;
  let mask = 0;
  for (const t of text.split(/[+,]/)) {
    if (!(t in VOICE_MASK)) throw new Error(`voices: ${JSON.stringify(t)} is not 1, 2, 3, f or vol`);
    mask |= VOICE_MASK[t];
  }
  return mask;
}

export class GameHardware {
  // options: { log, active(): can the client take game commands, kick(): send what is queued
  //            for sound now, reply(text): write to the program's input }
  constructor(options) {
    this.o = options;
    this.used = false; // the program has used it (the bridge then looks for MOVEs, too)
    this.shapes = new Map(); // slot -> 63 bytes
    this.sprites = new Array(8).fill(null); // {slot, color, flags, x, y}: where the C64 will have them
    this.mc = null;
    this.scripts = new Map(); // id -> { addr, cap, bytes, loops }
    this.channels = new Array(4).fill(null); // { id, mask }
    this.nextAddr = SCRIPT_BASE;
    this.audioUsed = false;
    this.primed = false; // the client's SID has been cleared for scripts
    this.pre = []; // for the next frame, before the screen: sound
    this.post = []; // ...after it: sprites
    this.unsentGlides = 0;
    this.glideBusy = false;
    this.glideDeadline = 0;
    this.waiters = [];
    this.timer = null;
  }

  // --- from the program --------------------------------------------------------

  sprite(data) {
    this.used = true;
    try {
      this.spriteOsc(data.split(';'));
    } catch (e) {
      this.o.log(`sprite: ${e.message}`);
    }
    return true;
  }

  spriteOsc([verb, ...a]) {
    const on = this.o.active();
    if (verb === 'def') {
      const slot = int(a[0], 0, SPRITE_SLOTS - 1, 'slot');
      const data = Buffer.from(a[1] ?? '', 'base64');
      if (data.length < 63 || data.length > 64) throw new Error(`a shape is 63 bytes, not ${data.length}`);
      const bytes = Uint8Array.from(data.subarray(0, 63));
      const old = this.shapes.get(slot);
      if (old && old.every((b, i) => b === bytes[i])) return;
      this.shapes.set(slot, bytes);
      if (on) this.queue(this.post, encodeSprDef(slot, bytes));
    } else if (verb === 'set') {
      const n = int(a[0], 0, 7, 'sprite'), slot = int(a[1], 0, SPRITE_SLOTS - 1, 'slot');
      const x = int(a[2], -512, 1023, 'x'), y = int(a[3], -256, 511, 'y'), color = int(a[4], 0, 15, 'colour');
      let flags = SPR.ON;
      for (const ch of a[5] ?? '') {
        if (!(ch in FLAG)) throw new Error(`flags: ${ch} is not x, y, m or b`);
        flags |= FLAG[ch];
      }
      const s = { slot, color, flags, x: ((x + SCREEN_X) % 512 + 512) % 512, y: ((y + SCREEN_Y) % 256 + 256) % 256 };
      this.setSprite(n, s, on);
    } else if (verb === 'hide') {
      const n = int(a[0], 0, 7, 'sprite');
      const s = this.sprites[n];
      if (s && s.flags & SPR.ON) this.setSprite(n, { ...s, flags: s.flags & ~SPR.ON }, on);
    } else if (verb === 'glide') {
      const n = int(a[0], 0, 7, 'sprite'), dx = int(a[1], -128, 127, 'dx'), dy = int(a[2], -128, 127, 'dy');
      const frames = int(a[3], 1, 255, 'frames');
      const s = this.sprites[n];
      if (!s || !(s.flags & SPR.ON)) throw new Error(`glide: sprite ${n} is not showing`);
      this.sprites[n] = { ...s, x: ((s.x + dx * frames) % 512 + 512) % 512, y: ((s.y + dy * frames) % 256 + 256) % 256 };
      if (on) {
        this.queue(this.post, encodeGlide(n, frames, dx, dy));
        this.unsentGlides++;
        this.glideBusy = true;
        this.glideDeadline = Math.max(this.glideDeadline, Date.now() + frames * 20 + GLIDE_SLACK_MS);
        this.watch();
      }
    } else if (verb === 'mc') {
      const mc = [int(a[0], 0, 15, 'colour'), int(a[1], 0, 15, 'colour')];
      if (this.mc && this.mc[0] === mc[0] && this.mc[1] === mc[1]) return;
      this.mc = mc;
      if (on) this.queue(this.post, [OP.SPRMC, ...mc]);
    } else if (verb === 'sync') {
      const tag = a[0] ?? '';
      if (!this.glideBusy) this.o.reply(`\x1b]8348;sync;${tag}\x07`);
      else this.waiters.push(tag);
    } else {
      throw new Error(`unknown OSC 8348 command ${verb}`);
    }
  }

  setSprite(n, s, on) {
    const old = this.sprites[n];
    if (old && old.slot === s.slot && old.color === s.color && old.flags === s.flags && old.x === s.x && old.y === s.y) return;
    this.sprites[n] = s;
    if (on) this.queue(this.post, encodeSpr(n, s.slot, s.color, s.flags, s.x, s.y));
  }

  sid(data) {
    this.used = true;
    try {
      this.sidOsc(data.split(';'));
    } catch (e) {
      this.o.log(`sid: ${e.message}`);
    }
    return true;
  }

  sidOsc([verb, ...a]) {
    const on = this.o.active();
    if (on && !this.primed && verb !== 'reset') { // the client's SID starts with its sample player's levels
      this.queue(this.pre, [OP.SIDRESET]);
      this.primed = true;
    }
    if (verb === 'def') {
      const id = int(a[0], 0, 255, 'id');
      const src = Uint8Array.from(Buffer.from(a[1] ?? '', 'base64'));
      const size = compileScript(src).bytes.length;
      let rec = this.scripts.get(id);
      if (!rec || size > rec.cap) {
        if (this.nextAddr + size > SCRIPT_END) throw new Error('script memory is full');
        rec = { addr: this.nextAddr, cap: size };
        this.nextAddr += size;
      }
      const { bytes, loops } = compileScript(src, rec.addr);
      this.scripts.set(id, { ...rec, bytes, loops });
      this.audioUsed = true;
      if (on) this.upload(rec.addr, bytes);
    } else if (verb === 'play') {
      const ch = int(a[0], 0, 3, 'channel'), id = int(a[1], 0, 255, 'id');
      const rec = this.scripts.get(id);
      if (!rec) throw new Error(`no script ${id}`);
      const mask = parseVoices(a[2]);
      this.channels[ch] = { id, mask };
      this.audioUsed = true;
      if (on) { this.queue(this.pre, encodeSidPlay(ch, rec.addr, mask)); this.o.kick(); }
    } else if (verb === 'stop') {
      this.audioUsed = true;
      if (a[0] === 'all') { this.channels.fill(null); if (on) this.queue(this.pre, encodeSidStop(255)); }
      else { const ch = int(a[0], 0, 3, 'channel'); this.channels[ch] = null; if (on) this.queue(this.pre, encodeSidStop(ch)); }
      if (on) this.o.kick();
    } else if (verb === 'w') {
      if (!a.length || a.length % 2) throw new Error('w takes register and value pairs');
      const pairs = a.map((v, i) => int(v, 0, i % 2 ? 255 : 24, i % 2 ? 'value' : 'register'));
      this.audioUsed = true;
      for (let i = 0; i < pairs.length; i += 120) if (on) this.queue(this.pre, encodeSidW(pairs.slice(i, i + 120)));
      if (on) this.o.kick();
    } else if (verb === 'reset') {
      this.channels.fill(null);
      this.audioUsed = true;
      if (on) { this.queue(this.pre, [OP.SIDRESET]); this.primed = true; this.o.kick(); }
    } else {
      throw new Error(`unknown OSC 8349 command ${verb}`);
    }
  }

  upload(addr, bytes) {
    for (let k = 0; k < bytes.length; k += 256) {
      const chunk = bytes.subarray(k, k + 256);
      this.queue(this.pre, encodePoke(addr + k, chunk));
    }
  }

  queue(q, bytes) {
    q.push(...bytes);
    if (this.pre.length + this.post.length > MAX_QUEUE) this.invalidate(); // nobody is taking it: start over on a fresh client
  }

  // --- to the client -----------------------------------------------------------

  // What to send with the next frame: before the screen's changes and after.
  takePre() { const q = this.pre; this.pre = []; return q; }
  takePost() { const q = this.post; this.post = []; this.unsentGlides = 0; return q; }
  pending() { return this.pre.length + this.post.length > 0; }

  // The client has lost what we told it (it restarted, or a frame was lost),
  // or is new: send everything again. Looping music starts over; effects don't.
  invalidate() {
    this.pre = [];
    this.post = [];
    this.unsentGlides = 0;
    this.glideBusy = false;
    this.primed = false;
    if (!this.o.active()) return;
    if (this.audioUsed) this.replayAudio();
    if (this.mc) this.post.push(OP.SPRMC, ...this.mc);
    for (const [slot, bytes] of this.shapes) this.post.push(...encodeSprDef(slot, bytes));
    this.sprites.forEach((s, n) => { if (s) this.post.push(...encodeSpr(n, s.slot, s.color, s.flags, s.x, s.y)); });
    this.release();
  }

  // The SID is the client's own again (a sound played through it): silence, and the
  // scripts that loop, from the top. Also after a fresh start of the client.
  audioLost() {
    if (!this.o.active() || !this.audioUsed) return;
    this.pre = [];
    this.replayAudio();
  }

  replayAudio() {
    this.primed = true;
    this.pre.push(OP.SIDRESET);
    for (const rec of this.scripts.values()) this.upload(rec.addr, rec.bytes);
    this.channels.forEach((c, ch) => {
      const rec = c && this.scripts.get(c.id);
      if (rec?.loops) this.pre.push(...encodeSidPlay(ch, rec.addr, c.mask));
    });
  }

  // The C64 says every glide has ended.
  glideDone() {
    if (this.unsentGlides) return; // a glide is still on its way: this was an earlier one's
    this.release();
  }

  release() {
    this.glideBusy = false;
    for (const tag of this.waiters.splice(0)) this.o.reply(`\x1b]8348;sync;${tag}\x07`);
  }

  // The C64 may not say (no client, a lost message): the time is up when it should be.
  watch() {
    clearTimeout(this.timer);
    const wait = this.glideDeadline - Date.now();
    this.timer = setTimeout(() => { if (Date.now() >= this.glideDeadline) this.release(); else this.watch(); }, Math.max(wait, 0) + 1);
    this.timer.unref?.();
  }

  dispose() {
    clearTimeout(this.timer);
  }
}
