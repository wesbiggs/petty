// Pretends to be a WiFi modem for a client built with DIAL: VICE's RS-232
// connects here, and ATDT host:port dials that address over TCP, answering
// CONNECT, then relays both ways until either side hangs up (NO CARRIER).
// +++ with a second of quiet either side drops to the command line, where
// ATH hangs up. Other AT commands get OK.
// usage: node scripts/fake-modem.js [port]   (then make vice PORT=port DIAL=...)
import net from 'node:net';

const port = Number(process.argv[2] ?? 6480);
const log = (...a) => console.error('[modem]', ...a);

net.createServer(term => {
  log('terminal connected');
  let line = '';
  let call = null;
  let online = false; // false in a call: the command line (after +++)
  let last = 0; // when the terminal last sent anything
  let escTimer = null;
  let held = ''; // the + of an escape so far
  const say = s => term.write(`\r\n${s}\r\n`);

  term.on('data', d => {
    const now = Date.now();
    const quiet = now - last >= 1000;
    last = now;
    clearTimeout(escTimer);
    if (call && online) {
      const t = d.toString();
      if (/^\++$/.test(t) && (held || quiet) && (held + t).length <= 3) {
        held += t;
        if (held === '+++') escTimer = setTimeout(() => { held = ''; online = false; say('OK'); log('escaped to the command line'); }, 1000);
        return;
      }
      call.write(Buffer.concat([Buffer.from(held), d]));
      held = '';
      return;
    }
    for (const b of d) {
      const ch = String.fromCharCode(b);
      if (ch !== '\r') { line += ch; continue; }
      const cmd = line.trim().toUpperCase();
      line = '';
      if (!cmd) continue;
      log(`< ${cmd}`);
      if (cmd === 'ATH') { call?.destroy(); call = null; say('OK'); continue; }
      const m = /^ATD[TP]?\s*(.+):(\d+)$/.exec(cmd);
      if (!m) { say(cmd.startsWith('AT') ? 'OK' : 'ERROR'); continue; }
      const c = call = net.connect(Number(m[2]), m[1].toLowerCase(), () => {
        log(`connected to ${m[1]}:${m[2]}`);
        online = true;
        say('CONNECT 38400');
      });
      c.on('data', x => term.write(x));
      c.on('error', e => log(e.message));
      c.on('close', () => { if (call !== c) return; call = null; say('NO CARRIER'); log('hung up'); });
    }
  });
  term.on('close', () => { log('terminal gone'); call?.destroy(); });
  term.on('error', () => {});
}).listen(port, '127.0.0.1', () => log(`listening on 127.0.0.1:${port}`));
