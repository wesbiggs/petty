; PETTY - thin terminal client for the C64
;
; Receives screen updates from the bridge over a SwiftLink (6551 ACIA
; at $DE00, NMI) and sends keyboard matrix codes back. See
; bridge/src/protocol.js for the wire format.

; --- hardware ---------------------------------------------------------------
SCREEN      = $0400
COLRAM      = $D800
CHARSET     = $3800             ; 2K: 0-127 ROM lowercase + patches, 128-255 inverse
RBUF        = $3700             ; 256-byte receive ring buffer
ROMCHARS    = $D800             ; lowercase half of the character ROM

ACIA_DATA   = $DE00
ACIA_STATUS = $DE01
ACIA_CMD    = $DE02
ACIA_CTRL   = $DE03

VIC_MEM     = $D018
BORDER      = $D020
BGCOLOR     = $D021

; KERNAL
NMIVEC      = $0318
JIFFY_LO    = $A2
KEYCOUNT    = $C6               ; keyboard buffer length
CURKEY      = $CB               ; matrix code of held key, 64 = none
BLNSW       = $CC               ; cursor blink switch (nonzero = off)
SHFLAG      = $028D             ; shift/C=/ctrl flags
MODE        = $0291             ; $80 = disable shift+C= charset toggle

; protocol
OP_GOTO     = 1
OP_COLOR    = 2
OP_PUT      = 3
OP_REPEAT   = 4
OP_SCROLL   = 5
OP_COLORS   = 6
OP_CLS      = 7
OP_FRAME    = 8
NUM_OPS     = 18                ; 16 and 17 (SOUND, PROBE) are in sound.inc

MSG_ACK     = 1
MSG_KEY     = 2
MSG_HELLO   = 3

REPEAT_DELAY = 20               ; jiffies before auto-repeat
REPEAT_RATE  = 3                ; jiffies between repeats

; --- zero page (BASIC's area; BASIC is not running) -------------------------
scr         = $FB               ; screen write pointer
colp        = $FD               ; colour write pointer (low byte == scr low)
src         = $10               ; generic pointers
dst         = $12
srcc        = $14
dstc        = $16
count       = $18
rptr        = $19               ; ring buffer read index
wptr        = $1A               ; ring buffer write index (NMI)
curcolor    = $1B
lastjiffy   = $1C
lastkey     = $1D
repcnt      = $1E
top         = $1F
bot         = $20
lines       = $21
row         = $22
glyph       = $23

; --- BASIC stub: 10 SYS2061 -------------------------------------------------
.segment "LOADADDR"
        .word $0801

.segment "CODE"
        .word @next, 10
        .byte $9E, "2061", 0
@next:  .word 0

start:
        .assert start = 2061, error, "SYS address mismatch"
        sei
        jsr init_charset
        jsr init_screen
        jsr sound_init
        lda #0
        sta rptr
        sta wptr
        lda #64
        sta lastkey
        lda #<nmi
        sta NMIVEC
        lda #>nmi
        sta NMIVEC+1
        jsr init_acia
        cli
        jsr dial                ; through a WiFi modem, if built with DIAL
        lda #MSG_HELLO
        jsr send

; --- main loop: decode commands forever ------------------------------------
cmdloop:
        jsr keypoll
        jsr rb_get
        cmp #NUM_OPS
        bcs cmdloop
        asl
        tax
        lda optable+1,x
        pha
        lda optable,x
        pha
        rts

optable:
        .word cmdloop-1, op_goto-1, op_color-1, op_put-1, op_repeat-1
        .word op_scroll-1, op_colors-1, op_cls-1, op_frame-1
        .word cmdloop-1, cmdloop-1, cmdloop-1, cmdloop-1
        .word cmdloop-1, cmdloop-1, op_poke-1
        .word op_sound-1, op_probe-1

op_goto:
        jsr rb_get
        cmp #25
        bcc :+
        lda #24
:       sta row
        jsr rb_get              ; clobbers X
        cmp #40
        bcc :+
        lda #39
:       ldx row
        clc
        adc rowlo,x
        sta scr
        sta colp
        lda rowhi,x
        adc #0
        sta scr+1
        clc
        adc #>(COLRAM-SCREEN)
        sta colp+1
        jmp cmdloop

op_color:
        jsr rb_get
        and #$0F
        sta curcolor
        jmp cmdloop

op_put:
        jsr rb_get
        sta count
        beq @done
@loop:  jsr rb_get
        jsr putcell
        dec count
        bne @loop
@done:  jmp cmdloop

op_repeat:
        jsr rb_get
        sta count
        jsr rb_get
        sta glyph
        lda count
        beq @done
@loop:  lda glyph
        jsr putcell
        dec count
        bne @loop
@done:  jmp cmdloop

op_colors:
        jsr rb_get
        sta BORDER
        jsr rb_get
        sta BGCOLOR
        jmp cmdloop

op_cls:
        jsr clear_screen
        jmp cmdloop

op_frame:
        lda #MSG_ACK
        jsr send
        jmp cmdloop

; POKE lo hi n d1..dn: n bytes (0 = 256) from lo + 256 * hi on (sound's tables).
op_poke:
        jsr rb_get
        sta dst
        jsr rb_get
        sta dst+1
        jsr rb_get
        sta count
@loop:  jsr rb_get
        ldy #0
        sta (dst),y
        inc dst
        bne :+
        inc dst+1
:       dec count
        bne @loop
        jmp cmdloop

; SCROLL top bot n: rows top..bot move up n, vacated rows cleared.
op_scroll:
        jsr rb_get
        sta top
        jsr rb_get
        sta bot
        jsr rb_get
        sta lines
        ldx bot                 ; ignore bad arguments
        cpx #25
        bcs @done
        cpx top
        bcc @done
        tax
        beq @done
        lda top
        sta row
@copy:  lda row                 ; while row + n <= bot: copy row+n -> row
        clc
        adc lines
        bcs @clear
        cmp bot
        beq :+
        bcs @clear
:       tax
        jsr set_src_row
        ldx row
        jsr set_dst_row
        ldy #39
:       lda (src),y
        sta (dst),y
        lda (srcc),y
        sta (dstc),y
        dey
        bpl :-
        inc row
        jmp @copy
@clear: ldx row                 ; clear row..bot
        cpx bot
        beq :+
        bcs @done
:       jsr set_dst_row
        ldy #39
:       lda #32
        sta (dst),y
        lda curcolor
        sta (dstc),y
        dey
        bpl :-
        inc row
        jmp @clear
@done:  jmp cmdloop

set_src_row:
        lda rowlo,x
        sta src
        sta srcc
        lda rowhi,x
        sta src+1
        clc
        adc #>(COLRAM-SCREEN)
        sta srcc+1
        rts

set_dst_row:
        lda rowlo,x
        sta dst
        sta dstc
        lda rowhi,x
        sta dst+1
        clc
        adc #>(COLRAM-SCREEN)
        sta dstc+1
        rts

; Write screen code in A with the current colour, advance, wrap at 1000.
putcell:
        ldy #0
        sta (scr),y
        lda curcolor
        sta (colp),y
        inc scr
        inc colp
        bne :+
        inc scr+1
        inc colp+1
:       lda scr+1
        cmp #>(SCREEN+1000)
        bne :+
        lda scr
        cmp #<(SCREEN+1000)
        bne :+
home:   lda #<SCREEN
        sta scr
        sta colp
        lda #>SCREEN
        sta scr+1
        lda #>COLRAM
        sta colp+1
:       rts

clear_screen:
        ldx #0
:       lda #32
        sta SCREEN,x
        sta SCREEN+$100,x
        sta SCREEN+$200,x
        sta SCREEN+$2E8,x
        lda curcolor
        sta COLRAM,x
        sta COLRAM+$100,x
        sta COLRAM+$200,x
        sta COLRAM+$2E8,x
        inx
        bne :-
        jmp home

; --- serial ------------------------------------------------------------------

; Next received byte in A, flags set from it; polls the keyboard while
; waiting. Clobbers X, Y.
rb_get:
        ldx rptr
        cpx wptr
        bne :+
        jsr keypoll
        jmp rb_get
:       inc rptr                ; before the load, so Z/N reflect the byte
        lda RBUF,x
        rts

; Transmit A (waits for the transmit register to empty).
send:
        pha
:       lda ACIA_STATUS
        and #$10
        beq :-
        pla
        sta ACIA_DATA
        rts

nmi:
        pha
        txa
        pha
        lda ACIA_STATUS         ; also acknowledges the interrupt
        and #$08                ; receive register full?
        beq :+
        lda ACIA_DATA
        ldx wptr
        sta RBUF,x
        inc wptr
:       pla
        tax
        pla
        rti

init_acia:
        sta ACIA_STATUS         ; programmed reset
        lda #%00011111          ; 1 stop, 8 bits, internal clock, 19200 (38400 on SwiftLink)
        sta ACIA_CTRL
        lda #%00001001          ; no parity, RTS low, TX irq off, RX irq on, DTR on
        sta ACIA_CMD
        lda ACIA_DATA           ; discard anything pending
        rts

.include "dial.inc"

; --- keyboard ----------------------------------------------------------------

; Once per jiffy: send KEY for new presses and auto-repeats. Clobbers A.
keypoll:
        lda JIFFY_LO
        cmp lastjiffy
        beq @out
        sta lastjiffy
        lda #0
        sta KEYCOUNT            ; we read the matrix, not the KERNAL buffer
        lda CURKEY
        cmp #64
        beq @none
        cmp lastkey
        bne @new
        dec repcnt
        bne @out
        lda #REPEAT_RATE
        sta repcnt
        bne @send
@new:   sta lastkey
        lda #REPEAT_DELAY
        sta repcnt
@send:  lda #MSG_KEY
        jsr send
        lda lastkey
        jsr send
        lda SHFLAG
        and #7
        jsr send
@out:   rts
@none:  sta lastkey
        rts

; --- setup -------------------------------------------------------------------

init_screen:
        lda #$1E                ; screen $0400, charset $3800
        sta VIC_MEM
        lda #0
        sta BORDER
        sta BGCOLOR
        lda #$80
        sta MODE
        lda #1
        sta BLNSW
        lda #15
        sta curcolor
        jsr clear_screen
        ldx #0
:       lda banner,x
        beq :+
        sta SCREEN,x
        inx
        bne :-
:       rts

; Screen codes for "petty: waiting for bridge..." (lowercase set).
banner:
        .byte 16,5,20,20,25,": ",23,1,9,20,9,14,7," ",6,15,18," ",2,18,9,4,7,5,"...",0

; Called with interrupts off.
init_charset:
        lda $01
        pha
        lda #$33                ; character ROM visible at $D000
        sta $01
        ldx #0
:       lda ROMCHARS,x
        sta CHARSET,x
        lda ROMCHARS+$100,x
        sta CHARSET+$100,x
        lda ROMCHARS+$200,x
        sta CHARSET+$200,x
        lda ROMCHARS+$300,x
        sta CHARSET+$300,x
        inx
        bne :-
        pla
        sta $01

        lda #<glyph_data        ; patch custom glyphs
        sta src
        lda #>glyph_data
        sta src+1
        ldx #0
@patch: cpx #NUM_GLYPHS
        beq @inverse
        lda #0
        sta dst+1
        lda glyph_slots,x       ; dst = CHARSET + slot * 8
        asl
        rol dst+1
        asl
        rol dst+1
        asl
        rol dst+1
        sta dst
        lda dst+1
        clc
        adc #>CHARSET
        sta dst+1
        ldy #7
:       lda (src),y
        sta (dst),y
        dey
        bpl :-
        lda src
        clc
        adc #8
        sta src
        bcc :+
        inc src+1
:       inx
        jmp @patch

@inverse:
        ldx #0
:       lda CHARSET,x
        eor #$FF
        sta CHARSET+$400,x
        lda CHARSET+$100,x
        eor #$FF
        sta CHARSET+$500,x
        lda CHARSET+$200,x
        eor #$FF
        sta CHARSET+$600,x
        lda CHARSET+$300,x
        eor #$FF
        sta CHARSET+$700,x
        inx
        bne :-
        rts

rowlo:
.repeat 25, i
        .byte <(SCREEN + i * 40)
.endrep
rowhi:
.repeat 25, i
        .byte >(SCREEN + i * 40)
.endrep

.macro RX_PENDING target
        lda rptr
        cmp wptr
        bne target
.endmacro
.include "sound.inc"
.include "glyphs.inc"
