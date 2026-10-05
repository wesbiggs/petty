// The CIA timer for a sample every `lines` raster lines, locked to the raster (the screen stays
// on, so a badline would otherwise delay writes): its latch, and the rate that gives.
export function lineTimer(lines, lineCycles, cpuHz) {
  const cycles = lineCycles * lines;
  return { latch: cycles - 1, rate: cpuHz / cycles };
}
