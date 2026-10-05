; PETTY - C64 client with a 40-column hi-res bitmap screen
;
; The C64 client's protocol (bridge/src/protocol.js) on a 40x25 screen drawn
; in the hi-res bitmap, announced with HELLO_ON 3. Each 8x8 cell has its own
; foreground and background (COLOR is foreground << 4 | background), so the
; character set needs no inverse half: screen codes 0-127 are the text
; client's (lowercase ROM plus the custom glyphs), and the bridge loads
; 128-255 with GLYPH as it needs them. UNDERLINE sets the bottom pixel row
; of what is written next.
;
; Memory (the VIC uses its second bank, $4000-$7FFF): font $4000-$47FF, cell
; colours $5C00, bitmap $6000-$7F3F, receive ring $8000-$8FFF (4K: a bitmap
; scroll takes ~90 ms). Sound (sound.inc) keeps its buffer and tables at $CD00-$CFFF.

; --- hardware ---------------------------------------------------------------
FONT        = $4000             ; 8 pages: row r of screen code c at FONT + r*256 + c
COLRAM      = $5C00             ; bitmap colours: high nibble fg, low nibble bg
BITMAP      = $6000
RBUF        = $8000
RBUF_END    = $9000
ROMCHARS    = $D800             ; lowercase half of the character ROM

ACIA_DATA   = $DE00
ACIA_STATUS = $DE01
ACIA_CMD    = $DE02
ACIA_CTRL   = $DE03

CIA2_PRA    = $DD00             ; bits 0-1: VIC bank, inverted

SPR_ON      = $D015
VIC_CR1     = $D011
VIC_CR2     = $D016
VIC_MEM     = $D018
BORDER      = $D020
VIC_BG      = $D021

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
OP_SPRITE   = 9
OP_NOSPRITE = 10
OP_GLYPH    = 11
OP_UNDERLINE = 12
OP_BITS     = 13
OP_VIEW     = 14
OP_POKE     = 15
NUM_OPS     = 18                ; 16 and 17 (SOUND, PROBE) are in sound.inc

VIEW_TERMINAL = 0
VIEW_LOAD   = 1

MSG_ACK     = 1
MSG_KEY     = 2
MSG_HELLO_ON = 4
DISPLAY_C64_HIRES = 3

COLS        = 40
ROWS        = 25
SPACE       = 32

REPEAT_DELAY = 20               ; jiffies before auto-repeat
REPEAT_RATE  = 3                ; jiffies between repeats

; --- zero page (BASIC's area; BASIC is not running) -------------------------
bp          = $FB               ; bitmap address of the current cell
cp          = $FD               ; colour address of the current cell
src         = $10
dst         = $12
cnt         = $16               ; 16-bit byte count for copy / fill
rp          = $18               ; ring buffer read pointer
wp          = $1A               ; ring buffer write pointer (NMI)
count       = $1C
curcolor    = $1D               ; foreground << 4 | background
lastjiffy   = $20
lastkey     = $21
repcnt      = $22
top         = $23
bot         = $24
lines       = $25
row         = $26
glyph       = $27
tmp         = $29
tmp2        = $2A
uline       = $2B               ; $FF: underline what is written, else 0

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
        jsr init_font
        jsr init_screen
        jsr sound_init
        lda #<RBUF
        sta rp
        sta wp
        lda #>RBUF
        sta rp+1
        sta wp+1
        lda #64
        sta lastkey
        lda #<nmi
        sta NMIVEC
        lda #>nmi
        sta NMIVEC+1
        jsr init_acia
        cli
        jsr dial                ; through a WiFi modem, if built with DIAL
        lda #MSG_HELLO_ON
        jsr send
        lda #DISPLAY_C64_HIRES
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
        .word op_sprite-1, op_nosprite-1, op_glyph-1, op_underline-1
        .word op_bits-1, op_view-1, op_poke-1
        .word op_sound-1, op_probe-1

op_goto:
        jsr rb_get
        cmp #ROWS
        bcc :+
        lda #ROWS-1
:       sta row
        jsr rb_get
        cmp #COLS
        bcc :+
        lda #COLS-1
:       sta tmp
        ldx row
        lda o40lo,x             ; cp = COLRAM + row * 40 + col
        clc
        adc tmp
        sta cp
        lda o40hi,x
        adc #>COLRAM
        sta cp+1
        lda #0                  ; bp = BITMAP + row * 320 + col * 8
        sta tmp2
        lda tmp
        asl
        rol tmp2
        asl
        rol tmp2
        asl
        rol tmp2
        clc
        adc o320lo,x
        sta bp
        lda tmp2
        adc o320hi,x
        adc #>BITMAP
        sta bp+1
        jmp cmdloop

op_color:
        jsr rb_get
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
        jsr rb_get              ; the background is part of each cell's colour
        jmp cmdloop

op_cls:
        jsr clear_screen
        jmp cmdloop

op_frame:
        lda #MSG_ACK
        jsr send
        jmp cmdloop

; No sprites here: skip SPRITE's 67 bytes and NOSPRITE's 1.
op_sprite:
        lda #67
        sta count
:       jsr rb_get
        dec count
        bne :-
        jmp cmdloop

op_nosprite:
        jsr rb_get
        jmp cmdloop

; GLYPH lo hi d0..d7: redefine screen code lo (hi is 0 here). rb_get leaves
; X alone.
op_glyph:
        jsr rb_get
        tax
        jsr rb_get
.repeat 8, r
        jsr rb_get
        sta FONT + r * 256,x
.endrep
        jmp cmdloop

op_underline:
        jsr rb_get
        beq :+
        lda #$FF
:       sta uline
        jmp cmdloop

; BITS n (d0..d7 colour)*n: n cells of an inline image, raw pixels and each
; cell's colour, at the write position, advancing. rb_get clobbers Y, so X
; counts the pixel rows.
op_bits:
        jsr rb_get
        sta count
        beq @done
@cell:  ldx #0
@row:   jsr rb_get
        pha
        txa
        tay
        pla
        sta (bp),y
        inx
        cpx #8
        bne @row
        jsr rb_get
        ldy #0
        sta (cp),y
        jsr advance
        dec count
        bne @cell
@done:  jmp cmdloop

; VIEW mode bg: a full-screen multicolour picture (loaded with POKE into the
; bitmap, the cell colours and colour RAM). LOAD blanks the screen in colour
; bg and switches to multicolour, SHOW shows the picture, TERMINAL goes back
; to hi-res (the bridge then redraws the terminal).
op_view:
        jsr rb_get
        sta tmp2
        jsr rb_get
        ldx tmp2
        cpx #VIEW_LOAD
        beq @load
        lda #$3B                ; screen on: the picture, or the terminal
        sta VIC_CR1
        cpx #VIEW_TERMINAL
        bne @done
        lda #$C8                ; no multicolour
        sta VIC_CR2
@done:  jmp cmdloop
@load:  sta BORDER
        sta VIC_BG
        lda #$2B                ; screen off (the border colour) while it loads
        sta VIC_CR1
        lda #$D8                ; multicolour
        sta VIC_CR2
        jmp cmdloop

; POKE lo hi n d1..dn: n bytes (0 = 256) from lo + 256 * hi on.
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

; SCROLL top bot n: rows top..bot move up n, vacated rows cleared. The write
; position is unchanged.
op_scroll:
        jsr rb_get
        sta top
        jsr rb_get
        sta bot
        jsr rb_get
        sta lines
        ldx bot                 ; ignore bad arguments
        cpx #ROWS
        bcs @bad
        cpx top
        bcc @bad
        tax
        bne :+
@bad:   jmp cmdloop
:       lda bot                 ; rows kept = bot - top + 1 - n
        sec
        sbc top
        clc
        adc #1
        sec
        sbc lines
        beq @clear
        bcc @clear
        sta row
        ldx top                 ; bitmap rows top+n.. to top..
        lda o320lo,x
        sta dst
        lda o320hi,x
        clc
        adc #>BITMAP
        sta dst+1
        txa
        clc
        adc lines
        tax
        lda o320lo,x
        sta src
        lda o320hi,x
        clc
        adc #>BITMAP
        sta src+1
        ldx row
        lda o320lo,x
        sta cnt
        lda o320hi,x
        sta cnt+1
        jsr copy
        ldx top                 ; and their colours
        lda o40lo,x
        sta dst
        lda o40hi,x
        clc
        adc #>COLRAM
        sta dst+1
        txa
        clc
        adc lines
        tax
        lda o40lo,x
        sta src
        lda o40hi,x
        clc
        adc #>COLRAM
        sta src+1
        ldx row
        lda o40lo,x
        sta cnt
        lda o40hi,x
        sta cnt+1
        jsr copy
        lda top
        clc
        adc row
        sta top
@clear: lda bot                 ; clear rows top..bot
        sec
        sbc top
        tax
        inx
        stx row
        ldx top
        lda o320lo,x
        sta dst
        lda o320hi,x
        clc
        adc #>BITMAP
        sta dst+1
        ldx row
        lda o320lo,x
        sta cnt
        lda o320hi,x
        sta cnt+1
        lda #0
        jsr fill
        ldx top
        lda o40lo,x
        sta dst
        lda o40hi,x
        clc
        adc #>COLRAM
        sta dst+1
        ldx row
        lda o40lo,x
        sta cnt
        lda o40hi,x
        sta cnt+1
        lda curcolor
        jsr fill
        jmp cmdloop

; Draw screen code A at the write position in the current colour, then
; advance, wrapping at the end of the screen. Clobbers X, Y.
putcell:
        tax
        ldy #0
.repeat 7, r
        lda FONT + r * 256,x
        sta (bp),y
        iny
.endrep
        lda FONT + 7 * 256,x
        ora uline
        sta (bp),y
        ldy #0
        lda curcolor
        sta (cp),y
; Move the write position to the next cell, wrapping at the end of the screen.
advance:
        lda bp                  ; next cell
        clc
        adc #8
        sta bp
        bcc :+
        inc bp+1
:       inc cp
        bne :+
        inc cp+1
:       lda cp+1
        cmp #>(COLRAM + 1000)
        bne @out
        lda cp
        cmp #<(COLRAM + 1000)
        beq home
@out:   rts

home:   lda #<BITMAP
        sta bp
        lda #>BITMAP
        sta bp+1
        lda #<COLRAM
        sta cp
        lda #>COLRAM
        sta cp+1
        rts

clear_screen:
        lda #<BITMAP
        sta dst
        lda #>BITMAP
        sta dst+1
        lda #<8000
        sta cnt
        lda #>8000
        sta cnt+1
        lda #0
        jsr fill
        lda #<COLRAM
        sta dst
        lda #>COLRAM
        sta dst+1
        lda #<1000
        sta cnt
        lda #>1000
        sta cnt+1
        lda curcolor
        jsr fill
        jmp home

; Copy cnt bytes from (src) to (dst), ascending, so dst may overlap above src.
copy:
        ldy #0
        ldx cnt+1
        beq @part
@page:  lda (src),y
        sta (dst),y
        iny
        bne @page
        inc src+1
        inc dst+1
        dex
        bne @page
@part:  ldx cnt
        beq @done
@byte:  lda (src),y
        sta (dst),y
        iny
        dex
        bne @byte
@done:  rts

; Fill cnt bytes from (dst) on with A.
fill:
        ldy #0
        ldx cnt+1
        beq @part
@page:  sta (dst),y
        iny
        bne @page
        inc dst+1
        dex
        bne @page
@part:  ldx cnt
        beq @done
@byte:  sta (dst),y
        iny
        dex
        bne @byte
@done:  rts

; --- serial ------------------------------------------------------------------

; Next received byte in A, flags set from it; polls the keyboard while
; waiting. Clobbers Y.
rb_get:
        lda rp
        cmp wp
        bne @have
        lda rp+1
        cmp wp+1
        bne @have
        jsr keypoll
        jmp rb_get
@have:  ldy #0
        lda (rp),y
        sta tmp
        inc rp
        bne @out
        inc rp+1
        lda rp+1
        cmp #>RBUF_END
        bne @out
        lda #>RBUF
        sta rp+1
@out:   lda tmp
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

; The byte is stored before wp moves on, so rb_get never reads ahead of it.
nmi:
        pha
        tya
        pha
        lda ACIA_STATUS         ; also acknowledges the interrupt
        and #$08                ; receive register full?
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
@out:   pla
        tay
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
        lda CIA2_PRA            ; VIC bank 1, $4000-$7FFF
        and #$FC
        ora #$02
        sta CIA2_PRA
        lda #$3B                ; hi-res bitmap, screen on, 25 rows
        sta VIC_CR1
        lda #$C8                ; no multicolour, 40 columns
        sta VIC_CR2
        lda #((COLRAM & $3FFF) / $400) << 4 | ((BITMAP & $3FFF) / $2000) << 3
        sta VIC_MEM
        lda #0
        sta SPR_ON
        sta BORDER
        lda #$80
        sta MODE
        lda #1
        sta BLNSW
        lda #$F0                ; light grey on black
        sta curcolor
        lda #0
        sta uline
        jsr clear_screen
        ldx #0
:       lda banner,x
        beq :+
        stx glyph
        jsr putcell
        ldx glyph
        inx
        bne :-
:       rts

; Screen codes for "petty: waiting for bridge..." (lowercase set).
banner:
        .byte 16,5,20,20,25,": ",23,1,9,20,9,14,7," ",6,15,18," ",2,18,9,4,7,5,"...",0

; FONT: codes 0-127 from the character ROM's lowercase half with the custom
; glyphs patched over it, turned into one page per pixel row; 128-255 blank
; until the bridge loads them. Called with interrupts off.
init_font:
        ldx #0
        txa
:       sta FONT,x
        sta FONT+$100,x
        sta FONT+$200,x
        sta FONT+$300,x
        sta FONT+$400,x
        sta FONT+$500,x
        sta FONT+$600,x
        sta FONT+$700,x
        inx
        bne :-
        lda $01
        pha
        lda #$33                ; character ROM visible at $D000
        sta $01
        lda #<ROMCHARS
        sta src
        lda #>ROMCHARS
        sta src+1
        ldx #0
@rom:   jsr store_glyph
        inx
        bpl @rom
        pla
        sta $01

        lda #<glyph_data
        sta src
        lda #>glyph_data
        sta src+1
        ldy #0
@patch: cpy #NUM_GLYPHS
        beq @done
        ldx glyph_slots,y
        sty tmp2
        jsr store_glyph
        ldy tmp2
        iny
        bne @patch
@done:  rts

; Store the 8 bytes at (src) as screen code X, and advance src by 8.
store_glyph:
.repeat 8, r
        ldy #r
        lda (src),y
        sta FONT + r * 256,x
.endrep
        lda src
        clc
        adc #8
        sta src
        bcc :+
        inc src+1
:       rts

; Byte offsets of text rows 0-25 in the bitmap (320 per row) and colours (40).
o320lo:
.repeat ROWS+1, i
        .byte <(i * 320)
.endrep
o320hi:
.repeat ROWS+1, i
        .byte >(i * 320)
.endrep
o40lo:
.repeat ROWS+1, i
        .byte <(i * 40)
.endrep
o40hi:
.repeat ROWS+1, i
        .byte >(i * 40)
.endrep

.macro RX_PENDING target
        lda rp
        cmp wp
        bne target
        lda rp+1
        cmp wp+1
        bne target
.endmacro
.include "sound.inc"
.include "glyphs.inc"
