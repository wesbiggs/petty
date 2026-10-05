; PETTY - SID volume staircase, a standalone program for calibrating a real machine
;
; Plays the signal bridge/scripts/sound-calibrate.js measures: the SID's volume
; register stepped through 0-15 and back (each level held for 256 samples at one
; sample per 123 cycles, 8010 Hz on PAL, 8315 Hz NTSC), twice, after a full-scale
; leader that marks where it starts. The three voices are held at a DC level, as
; PETTY's sound does (c64/sound.inc), so the levels are those it plays with. No
; serial link is needed. Record the C64's audio output with a line-in (not a
; microphone), then `node bridge/scripts/sound-calibrate.js recording.wav`.
;
; Run it, press a key when the recorder is going; it starts a second later.

CHROUT      = $FFD2
GETIN       = $FFE4
JIFFY       = $A2

SID         = $D400
SID_VOL     = $D418
VIC_CTRL1   = $D011
CIA2_TALO   = $DD04
CIA2_TAHI   = $DD05
CIA2_TBLO   = $DD06
CIA2_TBHI   = $DD07
CIA2_ICR    = $DD0D
CIA2_CRA    = $DD0E
CIA2_CRB    = $DD0F

LATCH       = 122                   ; a sample lasts LATCH + 1 = 123 cycles

val         = $FB
idx         = $FC
tbprev      = $FD

.segment "LOADADDR"
        .word $0801

.segment "CODE"
        .word @next, 10
        .byte $9E, "2061", 0
@next:  .word 0

start:
        .assert start = 2061, error, "SYS address mismatch"
        ldy #0
:       lda msg,y
        beq @wait
        jsr CHROUT
        iny
        bne :-
@wait:  jsr GETIN
        beq @wait
        ldx #60                     ; a second to start the recorder's meter
@sec:   lda JIFFY
:       cmp JIFFY
        beq :-
        dex
        bne @sec

        sei
        lda VIC_CTRL1               ; display off: no badlines
        and #$EF
        sta VIC_CTRL1
        lda #0
        ldx #$18
:       sta SID,x
        dex
        bpl :-
        ldx #0
:       lda #$FF
        sta SID+2,x                 ; pulse width $0FFF
        lda #$0F
        sta SID+3,x
        lda #$F0
        sta SID+6,x                 ; sustain 15
        lda #$49                    ; test, pulse, gate
        sta SID+4,x
        txa
        clc
        adc #7
        tax
        cpx #21
        bne :-
        lda #8                      ; the middle level to begin at
        sta SID_VOL

        lda #$7F                    ; CIA 2 raises no NMIs
        sta CIA2_ICR
        lda #LATCH
        sta CIA2_TALO
        lda #0
        sta CIA2_TAHI
        lda #$FF                    ; timer B counts timer A's underflows: a tick is a change
        sta CIA2_TBLO
        sta CIA2_TBHI
        lda #%01010001
        sta CIA2_CRB
        lda #%00010001
        sta CIA2_CRA
        lda CIA2_TBLO
        sta tbprev

        ldy #0
        sty idx
@plateau:
        ldy idx
        lda seq,y
        cmp #$FF
        beq @done
        sta val
        inc idx
        ldx #0                      ; 256 samples
@sample:
        ldy tbprev
:       cpy CIA2_TBLO
        beq :-
        ldy CIA2_TBLO
        sty tbprev
        lda val
        sta SID_VOL
        inx
        bne @sample
        beq @plateau

@done:
        lda #0
        sta CIA2_CRA
        sta CIA2_CRB
        ldx #$18
:       sta SID,x
        dex
        bpl :-
        lda VIC_CTRL1
        ora #$10
        sta VIC_CTRL1
        cli
        ldy #0
:       lda msgdone,y
        beq :+
        jsr CHROUT
        iny
        bne :-
:       rts

msg:    .byte 147, "PETTY SID VOLUME STAIRCASE", 13, 13
        .byte "RECORD THE AUDIO OUTPUT (LINE-IN),", 13
        .byte "THEN PRESS A KEY. THE SCREEN GOES", 13
        .byte "BLANK FOR ABOUT 2 SECONDS.", 13, 0
msgdone: .byte 13, "DONE. STOP THE RECORDING.", 13, 0

; Plateaus of 256 samples: 15 15 (the leader: its fall to 0 marks the start), then
; 0-15 and back to 0, twice.
seq:    .byte 15, 15
        .repeat 2
        .repeat 16, k
        .byte k
        .endrep
        .repeat 15, k
        .byte 14 - k
        .endrep
        .endrep
        .byte $FF
