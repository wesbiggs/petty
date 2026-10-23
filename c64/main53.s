; PETTY - C64 client with a soft 53-column screen
;
; The C64 client's protocol (bridge/src/protocol.js) on a 53x25 screen drawn
; in the hi-res bitmap with a 6x8 font, announced with HELLO_ON 4. Characters
; are 6 pixels wide, so 4 of them fill 3 bitmap cells (24 pixels), and the
; middle two straddle a cell boundary: character 4g+p of a row is drawn in
; phase p of group g. Column 52 is alone in cell 39, whose last 2 pixels stay
; blank. A cell holds one colour; the bridge sends the 4 characters of a group
; the same colour, and hardware sprites (SPRITE) that repaint the characters
; that lost theirs. Only non-space characters set colours (of every cell they
; touch), so writing a space never recolours its neighbours.
;
; Memory: glyph tables $2000-$4FFF (built at startup; $4000-$4FFF is in the
; VIC's bank but unused by it), and as the soft 80-column client: the VIC
; uses its second bank, $4000-$7FFF, sprite data $5000-$51FF, cell colours
; $5C00 (sprite pointers $5FF8), bitmap $6000-$7F3F, receive ring
; $8000-$8FFF (4K: a bitmap scroll takes ~90 ms).
;
; The combined client (mainall.s) also assembles this file, in a scope with MULTI
; defined: then only the screen's own part is here (.ifndef MULTI marks the rest).

; --- hardware ---------------------------------------------------------------
; Glyph tables, 8 pages each: row r of screen code c at table + r * 256 + c,
; codes 128-255 inverted. G is the glyph row in the top 6 bits.
.ifdef MULTI
; The combined client has its code at $2000-$3FFF: the tables go where the game's
; scripts would be ($9000-$BFFF, under BASIC's ROM, which it switches out), as this
; screen has no game hardware.
TBL_0       = $9000
TBL_1A      = $9800
TBL_1B      = $A000
TBL_2A      = $A800
TBL_2B      = $B000
TBL_3       = $B800
.else
TBL_0       = $2000             ; phase 0: G, in cell 0
TBL_1A      = $2800             ; phase 1: G >> 6, in cell 0's last 2 pixels
TBL_1B      = $3000             ;          G << 2, in cell 1's first 4
TBL_2A      = $3800             ; phase 2: G >> 4, in cell 1's last 4
TBL_2B      = $4000             ;          G << 4, in cell 2's first 2
TBL_3       = $4800             ; phase 3: G >> 2, in cell 2's last 6
.endif
SPRDATA     = $5000             ; 8 sprites of 64 bytes
COLRAM      = $5C00             ; bitmap colours: high nibble fg, low nibble bg
SPRPTR      = COLRAM + $3F8
BITMAP      = $6000
.ifndef MULTI
RBUF        = $8000
RBUF_END    = $9000
.endif

ACIA_DATA   = $DE00
ACIA_STATUS = $DE01
ACIA_CMD    = $DE02
ACIA_CTRL   = $DE03

CIA2_PRA    = $DD00             ; bits 0-1: VIC bank, inverted

SPR_X       = $D000             ; sprite n: X low at $D000+2n, Y at $D001+2n
SPR_XMSB    = $D010
SPR_ON      = $D015
SPR_YEXP    = $D017
SPR_PRIO    = $D01B             ; 0 = in front of the bitmap
SPR_MULTI   = $D01C
SPR_XEXP    = $D01D
SPR_COL     = $D027
VIC_CR1     = $D011
VIC_CR2     = $D016
VIC_MEM     = $D018
BORDER      = $D020

; KERNAL
NMIVEC      = $0318
JIFFY_LO    = $A2
KEYCOUNT    = $C6               ; keyboard buffer length
CURKEY      = $CB               ; matrix code of held key, 64 = none
STOP_KEY    = 63                ; ...of RUN/STOP
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
NUM_OPS     = 18                ; 16 and 17 (SOUND, PROBE) are in sound.inc

MSG_ACK     = 1
MSG_KEY     = 2
MSG_HELLO_ON = 4
DISPLAY_C64_53 = 4

COLS        = 53
ROWS        = 25
SPACE       = 32

REPEAT_DELAY = 20               ; jiffies before auto-repeat
REPEAT_RATE  = 3                ; jiffies between repeats

; --- zero page (BASIC's area; BASIC is not running) -------------------------
bp          = $FB               ; bitmap address of the current group's first cell
cp          = $FD               ; colour address of the same
src         = $10
dst         = $12
dst2        = $14
cnt         = $16               ; 16-bit byte count for copy / fill
rp          = $18               ; ring buffer read pointer
wp          = $1A               ; ring buffer write pointer (NMI)
count       = $1C
curcolor    = $1D               ; foreground 0-15
cellcol     = $1E               ; curcolor << 4 | bgcol
bgcol       = $1F
lastjiffy   = $20
lastkey     = $21
repcnt      = $22
top         = $23
bot         = $24
lines       = $25
row         = $26
glyph       = $27
col         = $28               ; the write position's column
tmp         = $29
tmp2        = $2A
sn          = $2B               ; SPRITE: number, column, row, data index
scol        = $2C
srow        = $2D
sidx        = $2E
inv         = $2F               ; init_tables: 0, or $FC for the inverse half

CLIENT_ASK  = 1                 ; this client can ask for the dial's settings (dialask.inc)

.ifndef MULTI
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
        jsr init_tables
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
        lda #DISPLAY_C64_53
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
.endif

optable:
        .word cmdloop-1, op_goto-1, op_color-1, op_put-1, op_repeat-1
        .word op_scroll-1, op_colors-1, op_cls-1, op_frame-1
        .word op_sprite-1, op_nosprite-1, cmdloop-1, cmdloop-1
        .word cmdloop-1, cmdloop-1, op_poke-1
        .word op_sound-1, op_probe-1
.ifdef MULTI
.repeat ::NUM_OPS_MULTI - NUM_OPS           ; the game's opcodes, which this screen does without
        .word cmdloop-1
.endrep
.endif

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
:       jsr goto_rc
        jmp cmdloop

; Set the write position to the row in `row` and the column in A.
goto_rc:
        sta col
        lsr                     ; group
        lsr
        sta tmp
        asl                     ; its first cell: group * 3 (C clear: group < 14)
        adc tmp
        sta tmp
        ldx row
        lda o40lo,x             ; cp = COLRAM + row * 40 + cell
        clc
        adc tmp
        sta cp
        lda o40hi,x
        adc #>COLRAM
        sta cp+1
        lda #0                  ; bp = BITMAP + row * 320 + cell * 8
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
        rts

op_color:
        jsr rb_get
        and #$0F
        sta curcolor
        jsr set_cellcol
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
        and #$0F
        sta bgcol
        jsr set_cellcol
        jmp cmdloop

op_cls:
        jsr clear_screen
        jmp cmdloop

op_frame:
        lda #MSG_ACK
        jsr send
        jmp cmdloop

; SPRITE n col row color d1..d63: sprite n over the character at col, row.
op_sprite:
        jsr rb_get
        and #7
        sta sn
        jsr rb_get
        sta scol
        jsr rb_get
        sta srow
        jsr rb_get
        ldx sn
        sta SPR_COL,x
        lda sn                  ; dst = SPRDATA + n * 64
        lsr
        lsr
        clc
        adc #>SPRDATA
        sta dst+1
        lda sn
        and #3
        asl
        asl
        asl
        asl
        asl
        asl
        sta dst
        lda #0
        sta sidx
@data:  jsr rb_get
        ldy sidx
        sta (dst),y
        iny
        sty sidx
        cpy #63
        bne @data
        lda sn
        asl
        tax
        lda srow                ; Y = 50 + row * 8
        asl
        asl
        asl
        clc
        adc #50
        sta SPR_X+1,x
        lda #0                  ; X = 24 + col * 6, 9 bits
        sta tmp2
        lda scol                ; col * 2 + col * 4 (each < 256)
        asl
        sta tmp
        asl
        clc
        adc tmp
        rol tmp2
        clc
        adc #24
        sta SPR_X,x
        lda tmp2
        adc #0
        lsr                     ; C = bit 8
        ldx sn
        lda SPR_XMSB
        bcc :+
        ora bitmask,x
        bcs :++
:       and notbit,x
:       sta SPR_XMSB
        lda SPR_ON
        ora bitmask,x
        sta SPR_ON
        jmp cmdloop

op_nosprite:
        jsr rb_get
        and #7
        tax
        lda SPR_ON
        and notbit,x
        sta SPR_ON
        jmp cmdloop

bitmask: .byte $01, $02, $04, $08, $10, $20, $40, $80
notbit: .byte $FE, $FD, $FB, $F7, $EF, $DF, $BF, $7F

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
        lda cellcol
        jsr fill
        jmp cmdloop

set_cellcol:
        lda curcolor
        asl
        asl
        asl
        asl
        ora bgcol
        sta cellcol
        rts

; Draw screen code A at the write position with the current colour, then
; advance, wrapping at the end of the screen. Clobbers X, Y.
putcell:
        tax
        lda col
        and #3
        asl
        tay
        lda phases+1,y
        pha
        lda phases,y
        pha
        rts

phases: .word put0-1, put1-1, put2-1, put3-1

; A non-space character colours the cells it touches: `first` to `last` of the group's three.
.macro COLOUR first, last
        cpx #SPACE
        beq :+
        lda cellcol
        ldy #first
        sta (cp),y
.if last <> first
        iny
        sta (cp),y
.endif
:
.endmacro

; The glyph's 8 rows into the cell at bp + y0, keeping the pixels in `keep`.
.macro DRAW y0, keep, table
        ldy #y0
.repeat 8, r
        lda (bp),y
        and #keep
        ora table + r * 256,x
        sta (bp),y
        iny
.endrep
.endmacro

put0:   COLOUR 0, 0
        DRAW 0, $03, TBL_0
        lda col
        cmp #COLS-1
        beq @eol
        inc col
        rts
@eol:   lda #0                  ; the row's last column, alone in its cell
        sta col
        lda #8
        ldy #1
        jmp advance

put1:   COLOUR 0, 1
        DRAW 0, $FC, TBL_1A
        DRAW 8, $0F, TBL_1B
        inc col
        rts

put2:   COLOUR 1, 2
        DRAW 8, $F0, TBL_2A
        DRAW 16, $3F, TBL_2B
        inc col
        rts

put3:   COLOUR 2, 2
        DRAW 16, $C0, TBL_3
        inc col
        lda #24                 ; the next group
        ldy #3

; Move bp on by A and cp by Y, then home if that is the end of the screen.
advance:
        clc
        adc bp
        sta bp
        bcc :+
        inc bp+1
:       tya
        clc
        adc cp
        sta cp
        bcc :+
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
        lda #0
        sta col
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
        lda cellcol
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

.ifndef MULTI
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
        bpl @restore            ; bit 7: the ACIA's interrupt, else RESTORE
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
@restore:
        lda CURKEY
        cmp #STOP_KEY           ; RUN/STOP+RESTORE?
        bne @out
        jmp restart

init_acia:
        sta ACIA_STATUS         ; programmed reset
        lda #%00011111          ; 1 stop, 8 bits, internal clock, 19200 (38400 on SwiftLink)
        sta ACIA_CTRL
        lda #%00001001          ; no parity, RTS low, TX irq off, RX irq on, DTR on
        sta ACIA_CMD
        lda ACIA_DATA           ; discard anything pending
        rts

.include "dial.inc"
.include "restart.inc"

; The next byte the NMI has put in the receive ring: C set and A = it, else C clear. Clobbers X.
dial_rx:
        lda rp
        cmp wp
        bne @have
        lda rp+1
        cmp wp+1
        beq @none
@have:  ldx #0
        lda (rp,x)
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
        sec
        rts
@none:  clc
        rts
.endif

; The dial's progress, and asking for its settings (dialask.inc), draw through this.
UI_COLS     = 53
CFG         = $0334             ; the cassette buffer
.if ::DIAL_DBGCODE              ; (:: as these are also assembled in a scope: mainall.s)
; A = screen code, X = column, Y = row.
ui_cell:
        sta ui_code
        sty row
        txa
        jsr goto_rc
        lda ui_code
        jmp putcell

ui_code: .byte 0

ui_clear:
        jmp clear_screen
.endif
.ifndef MULTI
.include "dialask.inc"

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
.endif

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
        lda #0                  ; sprites: off, hi-res, unexpanded, in front
        sta SPR_ON
        sta SPR_MULTI
        sta SPR_XEXP
        sta SPR_YEXP
        sta SPR_PRIO
        ldx #7
:       txa
        clc
        adc #(SPRDATA & $3FFF) / 64
        sta SPRPTR,x
        dex
        bpl :-
        lda #0
        sta BORDER
        sta bgcol
        lda #$80
        sta MODE
        lda #1
        sta BLNSW
        lda #15
        sta curcolor
        jsr set_cellcol
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

; Build the glyph tables from font6 (row r of code c at font6 + r * 128 + c,
; in the top 6 bits), codes 128-255 inverted. Called with interrupts off.
init_tables:
        ldy #0                  ; screen code
@code:  ldx #0
        cpy #$80
        bcc :+
        ldx #$FC
:       stx inv
        tya
        and #$7F
        tax
.repeat 8, r
        lda font6 + r * 128,x
        eor inv
        sta TBL_0 + r * 256,y
        lsr
        lsr
        sta TBL_3 + r * 256,y
        lsr
        lsr
        sta TBL_2A + r * 256,y
        lsr
        lsr
        sta TBL_1A + r * 256,y
        lda TBL_0 + r * 256,y
        asl
        asl
        sta TBL_1B + r * 256,y
        asl
        asl
        sta TBL_2B + r * 256,y
.endrep
        iny
        beq :+
        jmp @code
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

.ifndef MULTI
.macro RX_PENDING target
        lda rp
        cmp wp
        bne target
        lda rp+1
        cmp wp+1
        bne target
.endmacro
.include "sound.inc"
.endif
.include "font6x8.inc"
