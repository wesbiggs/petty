// What the C64's PROBE measurement (the cycles in a video frame) says about the machine. The
// client only measures (c64/sound.inc, op_probe); what the number means is decided here.

// Cycles in a video frame -> the machine's video standard. The CPU runs
// 63 cycles to a raster line on PAL, 65 on NTSC (64 on the oldest NTSC chips).
export const REGIONS = [
  { name: 'PAL', frame: 19656, lineCycles: 63, cpuHz: 985248 },
  { name: 'PAL-N', frame: 20280, lineCycles: 65, cpuHz: 1023440 },
  { name: 'NTSC', frame: 17095, lineCycles: 65, cpuHz: 1022727 },
  { name: 'NTSC (old)', frame: 16768, lineCycles: 64, cpuHz: 1022727 },
];

export function classifyRegion(frameCycles) {
  let best = REGIONS[0];
  for (const r of REGIONS) if (Math.abs(r.frame - frameCycles) < Math.abs(best.frame - frameCycles)) best = r;
  return { ...best, error: frameCycles - best.frame };
}
