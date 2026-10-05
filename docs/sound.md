# Sound: notes and measurements

How PETTY plays speech and music, and what was learned getting there. The usage is in the
[README](../README.md#sound-the-c64-and-c128-clients); this is the why. Most of the measurements come from the
prototype, [petty-d418](https://github.com/wesbiggs/petty-d418) (frozen), which has the tools that made them.
All figures are from VICE (reSID); **no real chip, SwiftLink or machine has been tried**, and real SIDs differ from the model and from each other.

## What the SID does with `$D418`

Measured with `calibrate.js` (petty-d418):

- **The volume steps are almost linear** on both chips, slightly compressed at the ends. `bridge/src/sound/dsp.js` has the
  measured tables (`LUTS.sid6581`, `sid8580`) so the quantizer allows for them.
- **The swing is small unless a voice holds a DC level.** The volume register scales what the voices output, and silent voices output
  nearly nothing: with the voices off the swing is 29% of full scale on a 6581 and 4% on an 8580. `sound_init` therefore holds all three voices
  at their highest pulse level (test bit, sustain 15): 92% on a 6581, 22% on an 8580. (VICE's "8580 + digiboost" plays at 35% with no voices,
  and less with them.) Real chips vary a lot.
- **The output is AC coupled** (a high-pass near 16 Hz), so a held level droops to zero in about 10 ms. Speech doesn't care.
- **Noise shaping and dither of the 4-bit quantizer make it worse** (this is for plain PCM, not the Viterbi encoder below). At 8 kHz there is
  no room above speech to push noise into, and the ear is most sensitive at 2-4 kHz. Plain rounding: 10 dB A-weighted SNR; first-order
  shaping 5 dB; second-order negative. Dither costs 3-7 dB more.

## Timing with the display on

- A badline (every 8th raster line) stops the CPU for about 43 of a line's 63 cycles (PAL), so a sample written there is late. In VICE that cost
  about 6 dB of speech-band SNR at 8 kHz with a free-running timer (11.6 against 17.6 dB blanked).
- **The raster lock.** The client finds the start of a raster line to the cycle: a loop of exactly one line + 1 cycles reads `$D012`, so its read
  slides one cycle later each pass until the line number jumps by 2. It then starts the timer a chosen number of cycles later, with a period that
  is a whole number of lines. Every write falls at the same cycle of its line, after the badline stall. PAL lines are 63 cycles, NTSC and PAL-N 65.
- Only the cycle within the line matters (`--sound-delay`). In VICE a sweep of 0 to 12 was flat (9.0-9.9 dB), so the default of 4 stands.
- It does not depend on the video mode: text and bitmap badlines are the same. What would break it is anything else that steals cycles at changing
  places: **sprites** (2 cycles a line each; the client turns them off while playing) or a raster effect that changes `$D011`'s Y scroll mid-frame.
- The C128's VIC is blank, so nothing is locked: it drops to 1 MHz with the ROMs out instead.

## The 2-bit code

Each sample is 2 bits, a sign and a size. The C64 keeps a 7-bit accumulator (its top 4 bits are the volume) and a step index into six steps
(1, 1.7, 2.9, 4.9, 8.35, 14.2); the index goes up after a large code and down after a small one. The bridge's encoder (`bridge/src/sound/codec.js`)
does the work: a Viterbi search over the decoder's states for the code sequence whose output is closest to the signal, in blocks of 256 samples with
128 of lookahead. Each block restarts from the state the committed path ended in: committing sample by sample from the best path so far leaves lasting
offsets, because the decoder integrates. It runs about 4 times faster than real time in JavaScript.

Compared on a 5-second phrase (`codec-eval.js`, `sid6581` table), SNR / A-weighted:

| | bits | kbit/s | SNR dB | A-weighted dB |
|---|---|---|---|---|
| PCM 4-bit (plain rounding) | 4 | 32 | 12.8 | 9.1 |
| PCM 3-bit | 3 | 24 | 2.1 | 2.3 |
| PCM 2-bit | 2 | 16 | -4.0 | -2.7 |
| **2-bit code** | 2 | 16 | 12.0 | 8.2 |
| 3-bit code | 3 | 24 | 12.6 | 8.9 |

Within about 1 dB of 4-bit PCM at half the rate (2 KB/s of a SwiftLink's 3.8). The parameters hardly matter: a grid over step tables and sizes spans
0.2 dB, and a 7-bit accumulator is as good as 8 or 10 (6 loses 0.2 dB). 12 kHz does not fit the loop (the worst copy needs about 115 cycles by
count, not measured, against 82).

**The stream length is 24 bits.** The count tells the C64 where the stream ends, so it cannot wrap: a wrapped count would put the end marker in
the wrong place and the C64 would read data as commands. 16 bits was 32.7 s; 24 bits is over 2 hours, and costs about 4 cycles in the counting step.

## The client loop

Four samples to a byte, so the loop is four copies, with the work spread over them to fit a sample (126 cycles at two lines per sample): copy 1 takes
the byte fetched earlier, 2 counts it, 3 fetches the next from the buffer and sends a credit, 4 looks for RUN/STOP and stops after the last byte.
Every copy writes the volume first, so the write time does not depend on the work, then decodes (49 cycles: two table lookups `DTAB` and `NIDX`, and
`OUTTAB`) and polls the serial receiver (9 cycles idle, 25 with a byte). The receiver is polled, not interrupt driven: an interrupt would move a
write by up to 45 cycles.

**Flow control.** A SwiftLink has no handshake, so the bridge sends 128 bytes and one more for each CREDIT byte the C64 sends back when it takes a
byte from its 256-byte buffer. The buffer holds about 64 ms. If it runs dry the C64 plays a quiet filler byte and carries on when data arrives;
the stream is then longer, and no bytes are lost.

## Bugs that cost days (the 6502 side)

- **The old 6526 CIA loses a flag that sets as it is read.** Polling the timer's interrupt flag stalled the stream (about 36% speed, the last window
  of bytes never arriving) on VICE's `-model c64`; the newer 8521 (`c64c`, the default) is fine. The robust tick is a change in a counter: CIA 2
  timer A sets the sample period, timer B counts its underflows, and a sample starts when B changes. A late poll then misses nothing.
  Breadbin C64s have the old chip.
- **The KERNAL's 60 Hz IRQ overruns the ACIA.** The 6551 holds one byte and a byte arrives every 260 µs at 38400 baud; the KERNAL interrupt takes over a
  millisecond. Once the ACIA's own interrupt is switched off for polling, nothing covers for it, so the client masks interrupts (`sei`) *before* it
  switches the ACIA over, and polls from then on.
- **A write to the wrong timer** (CIA 1 timer A instead of B) ran the stream at 60 samples a second. Easy to do, easy to see.
- Start-up prefill: the buffer is filled first from what the receive ring already holds, then from the ACIA itself.

## Hiss

The stream's noise is almost all the 4-bit output's own quantization: 16 levels, a step of 0.133, give white noise at -28.4 dB re full scale, and
the codec adds under 1 dB. `hiss.js` measures it on a clip: the error in 20 ms frames, split by how loud the signal was and by frequency. On a decaying
piano note the error is -27.7 dB overall and the same in the quietest quarter as the loudest, the signature of hiss; the signal is below it above
about 2 kHz, which is why it stands out. `--compress` changes nothing: it changes the signal, not the quantizer.

**`--sound-weight -0.6`** (the default) makes the encoder minimise the error filtered by `1 + a z^-1`, so error it attenuates is cheap. A negative
`a` puts the noise down in frequency, under the bass that masks it and out of 2-4 kHz, where the ear is most sensitive. On the piano, 2-3 kHz
noise went from -31.8 to -34.7 dB and 3-4 kHz from -32.5 to -36.6, in exchange for 0-0.5 kHz -34.0 to -27.6 (the music there is -12). `-0.8` goes
further. The A-weighted total does not change and the total noise rises 1.7 dB, so whether it sounds better is for listening.

**Adaptive weights** (LPC of each block's spectrum, as speech codecs use, with a beam that makes the search 4 times cheaper; `noise.js` is in the
bridge) **are not better than the fixed tilt**, on piano or speech. They trace out the same trade-off: noise falls in 2-4 kHz and rises below 1 kHz
by the same amount in log terms; the A-weighted total stays at -28 to -30 dB for every setting. This is the Gerzon-Craven limit: the average of a
quantizer's noise level over frequency, in dB, cannot go below white noise's. The 4-bit output sets that average at -28 dB, so lowering the noise where
it is heard means raising it elsewhere. What lowers it overall is finer or more steps, a higher output rate (more spectrum to spread over), or
filtering the images above 4 kHz (the sample-and-hold's). The fixed tilt won, and PETTY ships only that.

## The full `$D418` byte (experiment, not adopted)

`$D418` has the volume in bits 0-3 and the filter modes and a voice 3 mute above. With voices routed through the filter, each of the 256 bytes could give
a different level (c64cast describes this). In VICE's 6581 there are 60-125 different levels, in a ladder whose largest gap is half a volume step; in the
model that is worth about 3 dB for the 2-bit code. **In VICE itself the gain does not appear**: scored against the speech it is 1 to 1.5 dB *worse*
(11.4 against 12.6 dB), and the plan-against-recording score drops from about 19 dB to 13. My untested guess is that levels from the mute and filter bits
take longer to settle than one 125 µs sample, so each depends on the one before, which a table cannot say. Real filters vary much more. `OUTTAB`, the
per-accumulator byte the client writes, is the leftover of this: PETTY fills it with the volume nibble.

## Probing the machine

PETTY's PROBE measures only the cycles in a video frame (19656 PAL, 20280 PAL-N, 17095 NTSC, 16768 old NTSC; the bridge picks the nearest, within about
10 cycles on all of VICE's models). petty-d418 also tried to identify the SID: voice 3's oscillator is started from zero and read back (`$D41B`) 255
cycles later at three speeds for seven waveforms, and the combined waveforms differ between the chips (saw+triangle reads `38` on VICE's 6581 and `f8` on its
8580). It was right for all 12 combinations of VICE's video and SID models, but the signatures are reSID's, and a real chip is unlikely to match them; it
is left out of PETTY. `--sound-lut` is how you say which chip you have.

## Measured in VICE (PETTY)

Speech-band SNR against the speech itself, a sentence, display on, PAL, old CIA: 9-10 dB on all four clients (against about 15 dB against what the encoder
planned). The gap is the code and the weighting. With the screen blanked (petty-d418) the same codec scored 17-19 dB. The sound is recognisable and,
for music, surprisingly good; the hiss is noticeable.

## Not done

- A real SwiftLink, real machine, real SID (6581 and 8580), and the TeensyROM+. RUN/STOP on the C64 (only the bridge half is tested).
- NTSC on the new clients (hi-res was checked).
- Sound above 8 kHz, or with a tuned phase.
- A calibration from a recording of a real machine (a measured `--sound-lut`).
- S.A.M.-style formant output (the SID's voices as three formants, parameters streamed at 50 Hz).
- Gapless playback of several clips: each `say` or `play` is its own stream.
