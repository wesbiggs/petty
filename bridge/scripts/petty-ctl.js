#!/usr/bin/env node
// Sends a command to a running bridge's control port (default: 6465, the
// bridge's --port + 1) and prints the reply.
//   node bridge/scripts/petty-ctl.js theme            current theme and the choices
//   node bridge/scripts/petty-ctl.js theme amber      switch theme (or next / prev)

import net from 'node:net';
import { parseArgs } from 'node:util';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '6465' },
    host: { type: 'string', default: '127.0.0.1' },
  },
});

if (!positionals.length) {
  console.error('usage: petty-ctl.js [--port N] [--host H] theme [name|next|prev]');
  process.exit(2);
}

const sock = net.connect(Number(opt.port), opt.host, () => sock.write(positionals.join(' ') + '\n'));
let buf = '';
sock.setEncoding('utf8');
sock.on('data', d => {
  buf += d;
  const nl = buf.indexOf('\n');
  if (nl < 0) return;
  const reply = buf.slice(0, nl);
  const failed = reply.startsWith('error');
  (failed ? console.error : console.log)(reply);
  sock.end();
  process.exitCode = failed ? 1 : 0;
});
sock.on('error', e => {
  console.error(`petty-ctl: ${e.message} (is the bridge running?)`);
  process.exitCode = 1;
});
