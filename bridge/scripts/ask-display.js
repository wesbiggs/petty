// Asks the bridge what it is drawing on (OSC 8350 `display`) and prints the answer; also what the bridge tests run.
// usage: make bridge CMD="-- node bridge/scripts/ask-display.js", then connect a client.
process.stdin.setRawMode(true);
process.stdout.write('\x1b]8350;display\x07');
let heard = '';
process.stdin.on('data', d => {
  heard += d;
  if (heard.includes('\x07')) process.stdout.write(heard.replace(/[\x1b\x07]/g, ''));
});
setTimeout(() => process.exit(0), 6000);
