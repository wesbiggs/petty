; PETTY - sound for the C64 clients: speech and music through the SID's volume
; register, played modally (the screen stays on and still; any frames the
; program draws meanwhile wait in the bridge). A port of petty-d418's client.
;
; The bridge sends 2-bit codes, 4 samples to a byte (bridge/src/sound/codec.js:
; an adaptive delta code; DTAB, NIDX and OUTTAB, loaded with POKE, are its
; tables), after a SOUND command. The C64 plays them from a timer locked to the
; raster, so that with the display on a badline does not delay a write, and
; polls the serial receiver in the same loop (an interrupt would move a write).
; See the comments at `sound_stream` for the loop.
;
; SOUND latch_variant delay lat_lo lat_hi n_lo n_hi n_ex
;   variant  0: 63-cycle raster lines (PAL), 1: 65 (NTSC, PAL-N)
;   delay    cycles/5 between the raster line's start and the timer's: places
;            the writes in the line (the bridge's table, found by measuring)
;   latch    CIA timer latch: a sample lasts latch + 1 cycles, a whole number
;            of lines
;   n        bytes of codes that follow, 24 bits
; PROBE: the answer is MSG_PROBE and the cycles in a video frame, 16 bits.
; While a SOUND plays: RUN/STOP stops it (answered by MSG_ABORT, after the
; client has thrown away what the bridge still had in flight); otherwise it
; ends with MSG_DONE. MSG_CREDIT: one byte of codes taken from the buffer.
;
; Needs from the client: send, rb_get, rp/wp and the 16-bit receive ring.

OP_SOUND    = 16
OP_PROBE    = 17

MSG_DONE    = 5
MSG_CREDIT  = 6
MSG_PROBE   = 7
MSG_ABORT   = 8

SND_RING    = $CF00             ; 256-byte buffer of codes
DTAB        = $CE00             ; the tables (24 bytes each, and 128)
NIDX        = $CE40
OUTTAB      = $CD00

SID         = $D400
SID_VOL     = $D418
VIC_RASTER  = $D012
CIA1_KBD    = $DC00
CIA1_KBDIN  = $DC01
CIA1_TBLO   = $DC06             ; (PROBE counts frames with CIA 1's timer B)
CIA1_TBHI   = $DC07
CIA1_CRB    = $DC0F
CIA2_TALO   = $DD04             ; the sample clock is CIA 2, which nothing else here uses:
CIA2_TAHI   = $DD05             ; timer A sets the sample period, timer B counts its underflows
CIA2_TBLO   = $DD06
CIA2_TBHI   = $DD07
CIA2_ICR    = $DD0D
CIA2_CRA    = $DD0E
CIA2_CRB    = $DD0F

; --- zero page, clear of the client's (this stays put while the screen waits) -
acc         = $30               ; the decoder's accumulator,
idx4        = $31               ; step index * 4,
cur         = $32               ; the byte of codes being played,
nxtb        = $33               ; the next one,
outv        = $34               ; and the byte to write at the next tick
rlo         = $35               ; bytes of codes still to fetch, 24 bits
rhi         = $36
rex         = $37
eof         = $38               ; the byte being played is the last
under       = $39               ; times the buffer ran dry
need        = $3A               ; bytes to buffer before starting
arp         = $3B               ; the buffer's read and write indices
awp         = $3C
sprev       = $3D               ; slide: the last raster line read
sdelay      = $3E
slc         = $3F               ; 0: 63-cycle lines, 1: 65
sborder     = $40               ; the border colour, put back after
stmp        = $41
tbprev      = $42               ; the last count of timer B

; --- start-up -----------------------------------------------------------------

; Every SID register zero, then three voices held at their highest level (test
; bit, pulse, sustain 15): the volume register scales what the voices output,
; and silent voices output almost nothing, so the held ones give the volume
; steps something to scale (see the README of petty-d418).
sound_init:
        lda #0
        ldx #$18
:       sta SID,x
        dex
        bpl :-
        ldx #0
:       lda #$FF
        sta SID+2,x             ; pulse width $0FFF
        lda #$0F
        sta SID+3,x
        lda #$F0
        sta SID+6,x             ; sustain 15
        lda #$49                ; test, pulse, gate
        sta SID+4,x
        txa
        clc
        adc #7
        tax
        cpx #21
        bne :-
        rts

; --- PROBE --------------------------------------------------------------------

; The cycles in one video frame, by a CIA timer between two visits to the same
; raster line: about 19656 on PAL, 17095 on NTSC, 20280 on PAL-N.
op_probe:
        sei
        lda #$FF                ; timer B counts down from $FFFF
        sta CIA1_TBLO
        sta CIA1_TBHI
:       lda VIC_RASTER          ; line $80
        cmp #$80
        bne :-
        lda #%00010001          ; start, continuous, force load
        sta CIA1_CRB
:       lda VIC_RASTER          ; leave it
        cmp #$80
        beq :-
:       lda VIC_RASTER          ; and meet it again, a frame later
        cmp #$80
        bne :-
        lda CIA1_TBHI
        sta stmp
        ldx CIA1_TBLO
        lda #0
        sta CIA1_CRB
        lda #$FF                ; elapsed = $FFFF - the timer
        sec
        sbc stmp
        sta stmp
        txa
        eor #$FF
        tax
        cli
        lda #MSG_PROBE
        jsr send
        txa
        jsr send
        lda stmp
        jsr send
        jmp cmdloop

; --- SOUND --------------------------------------------------------------------

op_sound:
        jsr rb_get
        sta slc
        jsr rb_get
        sta sdelay
        jsr rb_get
        sta srate
        jsr rb_get
        sta srate+1
        jsr rb_get
        sta rlo
        jsr rb_get
        sta rhi
        jsr rb_get
        sta rex
        lda #128                ; start when min(128, n) bytes are in
        ldx rex
        bne :+
        ldx rhi
        bne :+
        cmp rlo
        bcc :+
        lda rlo
:       sta need
        lda rlo                 ; n - 1 are left to fetch once the first is taken
        bne @dl
        lda rhi
        bne @dh
        dec rex
@dh:    dec rhi
@dl:    dec rlo
        sei                     ; first: the KERNAL's 60 Hz interrupt takes over a millisecond, and
                                ; the NMI that would cut in is about to be switched off (the ACIA
                                ; holds one byte, and a byte comes every 260 us)
        lda #%00001011          ; no receive interrupts: this loop polls
        sta ACIA_CMD
        lda #0
        sta arp
        sta awp
@fill:  lda awp                 ; fill the buffer: first with what the NMI had put in the
        sec                     ; receive ring, then from the ACIA itself
        sbc arp
        cmp need
        bcs @go
        lda rp
        cmp wp
        bne @ring
        lda rp+1
        cmp wp+1
        bne @ring
        lda ACIA_STATUS
        and #$08
        beq @fill
        lda ACIA_DATA
        ldx awp
        sta SND_RING,x
        inc awp
        jmp @fill
@ring:  jsr rb_get
        ldx awp
        sta SND_RING,x
        inc awp
        jmp @fill
@go:    jsr sound_play
        cmp #0
        bne @aborted
        lda #%00001001          ; receive interrupts on again
        sta ACIA_CMD
        lda #MSG_DONE
        jsr send
        jmp cmdloop
@aborted:
        jsr sound_drain         ; (the receiver is still off)
        lda #%00001001
        sta ACIA_CMD
        lda #MSG_ABORT
        jsr send
        jmp cmdloop

; What the client's NMI does with a byte, for a byte the ACIA holds while its
; interrupt is off. Clobbers A, Y.
rx_to_ring:
        lda ACIA_STATUS
        and #$08
        beq @out
        lda ACIA_DATA
        ldy #0
        sta (wp),y
        inc wp
        bne @out
        inc wp+1
        lda wp+1
        cmp #>RBUF_END
        bne @out
        lda #>RBUF
        sta wp+1
@out:   rts

; After a stop: wait for RUN/STOP to be let go (or it would reach the program
; as a keypress), then throw away what the bridge had in flight until the line
; has been quiet for about 60 ms. The bridge stops sending when it sees ABORT,
; but that comes after this.
sound_drain:
        lda #$7F                ; keyboard column 7: RUN/STOP is bit 7 of the row
        sta CIA1_KBD
:       lda CIA1_KBDIN
        and #$80
        beq :-
        lda #$FF
        sta CIA1_KBD
@restart:
        ldx #17
@outer: ldy #0
@inner: lda ACIA_STATUS
        and #$08
        bne @got
        dey
        bne @inner
        dex
        bne @outer
        rts
@got:   lda ACIA_DATA
        jmp @restart

; The sample clock stops (the KERNAL's timers, on CIA 1, were never touched).
sound_timers_off:
        lda #0
        sta CIA2_CRA
        sta CIA2_CRB
        rts

; --- playback -----------------------------------------------------------------

; Plays what is in the buffer and what follows. Returns A = 0 when done, 1 when
; stopped with RUN/STOP.
sound_play:
        sei
        lda BORDER
        sta sborder
        lda #5
        sta BORDER
        lda #8                  ; the middle level, so the first sample is no big step
        sta SID_VOL
        lda #$7F                ; CIA 2 raises no NMIs (the ACIA's line)
        sta CIA2_ICR
        lda #0
        sta CIA2_CRA
        sta CIA2_CRB
        lda srate               ; timer A: a sample's cycles
        sta CIA2_TALO
        lda srate+1
        sta CIA2_TAHI
        lda #$FF                ; timer B: counts down from $FFFF, a step a sample
        sta CIA2_TBLO
        sta CIA2_TBHI
:       lda VIC_RASTER          ; line $F9: below the display, no badline
        cmp #$F9
        bne :-
        lda slc
        bne :+
        jsr slide63
        jmp @slid
:       jsr slide65
@slid:  ldx sdelay
        beq :++
:       dex
        bne :-
:       lda #%01010001          ; timer B, counting A's underflows; force load, start
        sta CIA2_CRB
        lda #%00010001          ; and timer A: this write is the phase of every sample
        sta CIA2_CRA
        lda CIA2_TBLO
        sta tbprev
        jmp sound_stream

; Waits until a raster line starts, to the cycle: a loop of exactly one line + 1
; cycles reads the raster line once an iteration, so its read slides one cycle
; later in the line each time. A read at the last cycle of a line is followed,
; a loop later, by one at the first cycle of the line after next: the line
; number jumps by 2 (or by 202, mod 256, over the end of the frame). Returns
; with that read 19 cycles behind, so at the same cycle of the line on every
; run. It runs in the lines below the display, which have no badlines.
; An iteration is 18 (body) + 4 (the second compare) + 2 (LDX) + 5 * n - 1 (the
; pad loop) + 2 per NOP + 3 (JMP) = 26 + 5 * n + 2 * nops.
.macro SLIDE name, padn, padnops
name:
        lda VIC_RASTER
        sta sprev
:       lda VIC_RASTER          ; 4
        tax                     ; 2
        sec                     ; 2
        sbc sprev               ; 3
        stx sprev               ; 3
        cmp #2                  ; 2
        beq :++                 ; 2 (3 when taken): to the exit
        cmp #202                ; 2
        beq :++                 ; 2: to the exit
        ldx #padn               ; 2
:       dex                     ; 2
        bne :-                  ; 3 (2 on the last)
.repeat padnops
        nop
.endrep
        jmp :--                 ; 3: to the loop head
:       rts
.endmacro
; (the macro's anonymous labels are, in order, the loop head, the pad loop, and the exit)

        SLIDE slide63, 6, 4     ; 26 + 30 + 8 = 64
        SLIDE slide65, 8, 0     ; 26 + 40     = 66

; --- the stream loop ----------------------------------------------------------
;
; Each sample is a 2-bit code (sign, size) that moves an accumulator by a step
; that adapts to the codes; OUTTAB[acc] is what is written to the volume
; register. DTAB[idx4 + code] is the signed move, NIDX[idx4 + code] the next
; idx4. Four samples to a byte, so the loop is four copies, and the work is
; spread over them so each fits in a sample (126 cycles with two lines to a
; sample):
;   1: take the byte fetched earlier        2: count it    3: fetch the next, and
;   send a credit                           4: look for RUN/STOP, stop if that
;                                              was the last byte
; Every copy writes first, so the write time does not depend on the work, and
; polls the receiver last.

; A sample starts when timer B, which counts timer A's underflows, changes. The
; counter, not an interrupt flag: the flag register of the old 6526 loses a flag that
; sets as it is read, and a late poll would miss a tick that a counter keeps.
.macro TICK
        ldx tbprev              ; 3
:       cpx CIA2_TBLO           ; 4
        beq :-                  ; 3
        ldx CIA2_TBLO           ; 4
        stx tbprev              ; 3
        lda outv
        sta SID_VOL
.endmacro

.macro DECODE                   ; 49 cycles
        asl cur                 ; the sign
        lda #0
        rol
        asl cur                 ; the size
        rol                     ; A = sign * 2 + size
        ora idx4
        tay
        lda acc
        clc
        adc DTAB,y
        bpl :+
        cmp #$C0                ; below 0 or above 127: saturate
        lda #127
        bcc :+
        lda #0
:       sta acc
        tax
        lda NIDX,y
        sta idx4
        lda OUTTAB,x
        sta outv
.endmacro

.macro RXPOLL                   ; 9 cycles with nothing, 25 with a byte
        lda ACIA_STATUS
        and #$08
        beq :+
        lda ACIA_DATA
        ldx awp
        sta SND_RING,x
        inc awp
:
.endmacro

sound_stream:
        ldx arp                 ; the first byte
        lda SND_RING,x
        inc arp
        sta nxtb
        lda #MSG_CREDIT
        sta ACIA_DATA
        lda #64                 ; the decoder's start state: the encoder's too
        sta acc
        lda #0
        sta idx4
        sta eof
        sta under
        lda #8
        sta outv
@group:
        TICK                    ; copy 1
        lda nxtb
        sta cur
        DECODE
        RXPOLL

        TICK                    ; copy 2: count the byte to fetch
        DECODE
        RXPOLL
        lda rlo
        ora rhi
        ora rex
        bne :+
        jmp @last
:       lda rlo
        bne @dl2
        lda rhi
        bne @dh2
        dec rex
@dh2:   dec rhi
@dl2:   dec rlo
@copy3:
        TICK                    ; copy 3: fetch it
        DECODE
        RXPOLL
        lda arp
        cmp awp
        bne :+
        jmp @dry
:       tax
        inc arp
        lda SND_RING,x
        sta nxtb
        lda #MSG_CREDIT
        sta ACIA_DATA
@copy4:
        TICK                    ; copy 4
        DECODE
        RXPOLL
        lda #$7F                ; RUN/STOP?
        sta CIA1_KBD
        lda CIA1_KBDIN
        bpl @stop
        lda eof
        bne @out
        jmp @group
@out:   lda #0
        jmp @end
@stop:  lda #1
@end:
        pha
        lda #0
        sta SID_VOL
        lda #$FF
        sta CIA1_KBD
        jsr sound_timers_off
        lda sborder
        sta BORDER
        cli
        pla
        rts

@last:  lda #1                  ; nothing left to fetch: this byte is the last
        sta eof
        jmp @copy3

; The buffer is empty: play a quiet filler byte, and count the byte as not
; yet fetched.
@dry:   lda eof
        bne :++
        inc rlo
        bne :+
        inc rhi
        bne :+
        inc rex
:       lda #$22
        sta nxtb
        inc under
:       jmp @copy4

srate:  .word 125
