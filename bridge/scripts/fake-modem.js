// Pretends to be a WiFi modem for a client built with DIAL: VICE's RS-232
// connects here, and ATDT host:port dials that address over TCP, answering
// CONNECT, then relays both ways until either side hangs up (NO CARRIER).
// Other AT commands get OK.
// usage: node scripts/fake-modem.js [port]   (then make vice PORT=port DIAL=...)
import net from 'node:net';

const port = Number(process.argv[2] ?? 6480);
const log = (...a) => console.error('[modem]', ...a);

net.createServer(term => {
  log('terminal connected');
  let line = '';
  let call = null;
  const say = s => term.write(`\r\n${s}\r\n`);

  term.on('data', d => {
    if (call) return call.write(d);
    for (const b of d) {
      const ch = String.fromCharCode(b);
      if (ch !== '\r') { line += ch; continue; }
      const cmd = line.trim().toUpperCase();
      line = '';
      if (!cmd) continue;
      log(`< ${cmd}`);
      const m = /^ATD[TP]?\s*(.+):(\d+)$/.exec(cmd);
      if (!m) { say(cmd.startsWith('AT') ? 'OK' : 'ERROR'); continue; }
      call = net.connect(Number(m[2]), m[1].toLowerCase(), () => {
        log(`connected to ${m[1]}:${m[2]}`);
        say('CONNECT 38400');
      });
      call.on('data', x => term.write(x));
      call.on('error', e => log(e.message));
      call.on('close', () => { call = null; say('NO CARRIER'); log('hung up'); });
    }
  });
  term.on('close', () => { log('terminal gone'); call?.destroy(); });
  term.on('error', () => {});
}).listen(port, '127.0.0.1', () => log(`listening on 127.0.0.1:${port}`));
