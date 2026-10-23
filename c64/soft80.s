; PETTY - the C64 client's soft 80-column screen: 80x25 in the bitmap with a 4x8 font,
; display 2 (c64-80)
;
; One of the client's four screens (main.s assembles it in a scope; the receive ring,
; keyboard, dial, sound, game hardware, VIEW, CELLS and POKE are the core's). Each 8x8
; bitmap cell holds two characters and one colour; the bridge sends both the same
; colour, and hardware sprites (SPRITE) that repaint the character that lost its colour,
; with the sprite numbers the game's sprites leave free. Only non-space characters set
; a cell's colour, so writing a space never recolours its neighbour. UNDERLINE
; underlines the bottom pixel row of a character. MOVE moves pairs of columns (whole
; cells), and inline images come in whole cells (CELLS).
;
; Memory (the VIC's second bank): the game's sprite shapes $4800-$57FF, the colour
; sprites' data $5800-$59FF, cell colours $5C00 (sprite pointers $5FF8), bitmap
; $6000-$7F3F; glyph tables $A000-$AFFF, under BASIC's ROM, which is switched out.

; --- hardware ---------------------------------------------------------------
TBL_L       = $A000             ; 8 pages: glyph row r of code c, left half (under BASIC's ROM)
TBL_R       = $A800             ; 8 pages: the same in the right half
SPRDATA     = $5800             ; 8 sprites of 64 bytes, after the game's shapes
COLRAM      = $5C00             ; bitmap colours: high nibble fg, low nibble bg
SPRPTR      = COLRAM + $3F8
BITMAP      = $6000

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
BLNSW       = $CC               ; cursor blink switch (nonzero = off)
MODE        = $0291             ; $80 = disable shift+C= charset toggle

MSG_ACK     = 1

COLS        = 80
ROWS        = 25
SPACE       = 32

; --- zero page (BASIC's area; BASIC is not running) -------------------------
bp          = $FB               ; bitmap address of the current cell
cp          = $FD               ; colour address of the current cell
src         = $10
dst         = $12
dst2        = $14
cnt         = $16               ; 16-bit byte count for copy / fill
count       = $1C
curcolor    = $1D               ; foreground 0-15
cellcol     = $1E               ; curcolor << 4 | bgcol
bgcol       = $1F
top         = $23
bot         = $24
lines       = $25
row         = $26
glyph       = $27
half        = $28               ; 0 = left character of the cell, 1 = right
tmp         = $29
tmp2        = $2A
sn          = $2B               ; SPRITE: number, column, row, data index
scol        = $2C
srow        = $2D
sidx        = $2E

uline       = $39               ; $FF: underline what is written, else 0 (after sound.inc's)

; Opcodes 0-28 (main.s handles 27, MODE).
optable:
        .word cmdloop-1, op_goto-1, op_color-1, op_put-1, op_repeat-1
        .word op_scroll-1, op_colors-1, op_cls-1, op_frame-1
        .word op_sprite-1, op_nosprite-1, cmdloop-1, op_underline-1
        .word cmdloop-1, op_view-1, op_poke-1
        .word op_sound-1, op_probe-1
        .word op_sprdef-1, op_spr-1, op_glide-1, op_move-1
        .word op_sidw-1, op_sidplay-1, op_sidstop-1, op_sidreset-1, op_sprmc-1
        .word cmdloop-1, op_cells-1     ; (27, MODE, is main.s's)

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
        lsr                     ; cell column; C = right half
        sta tmp
        lda #0
        rol
        sta half
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

; UNDERLINE on: underline what PUT and REPEAT write from now on (0 = off).
op_underline:
        jsr rb_get
        beq :+
        lda #$FF
:       sta uline
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
        lda #0                  ; X = 24 + col * 4, 9 bits
        sta tmp2
        lda scol
        asl
        rol tmp2
        asl
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
        txa                     ; its own block, hi-res, unexpanded, in front: the game
        clc                     ; may have had this sprite before
        adc #(SPRDATA & $3FFF) / 64
        sta SPRPTR,x
        lda notbit,x
        and SPR_MULTI
        sta SPR_MULTI
        lda notbit,x
        and SPR_XEXP
        sta SPR_XEXP
        lda notbit,x
        and SPR_YEXP
        sta SPR_YEXP
        lda notbit,x
        and SPR_PRIO
        sta SPR_PRIO
        jmp cmdloop

op_nosprite:
        jsr rb_get
        and #7
        tax
        lda SPR_ON
        and notbit,x
        sta SPR_ON
        jmp cmdloop

notbit: .byte $FE, $FD, $FB, $F7, $EF, $DF, $BF, $7F   ; (bitmask is game.inc's)

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
        ldy #0
        cpx #SPACE              ; a space keeps its neighbour's colour
        beq :+
        lda cellcol
        sta (cp),y
:       lda half
        bne @right
.repeat 7, r
        lda (bp),y
        and #$0F
        ora TBL_L + r * 256,x
        sta (bp),y
        iny
.endrep
        lda uline               ; the bottom row: underlined, in this half
        and #$F0
        ora TBL_L + 7 * 256,x
        sta tmp2
        lda (bp),y
        and #$0F
        ora tmp2
        sta (bp),y
        inc half
        rts
@right:
.repeat 7, r
        lda (bp),y
        and #$F0
        ora TBL_R + r * 256,x
        sta (bp),y
        iny
.endrep
        lda uline
        and #$0F
        ora TBL_R + 7 * 256,x
        sta tmp2
        lda (bp),y
        and #$F0
        ora tmp2
        sta (bp),y
        lda #0                  ; next cell
        sta half
        lda bp
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
        lda #0
        sta half
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

; The dial's progress, and asking for its settings (dialask.inc), draw through this.
.if ::DIAL_DBGCODE              ; (:: as this is assembled in a scope)
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
        lda #0
        sta uline
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

; Build TBL_L and TBL_R from font4: row r of screen code c at TBL_x + r*256 + c,
; codes 128-255 inverted. Called with interrupts off.
init_tables:
        lda #0
        sta row
@row:   lda #<font4             ; src = font4 + row, then 8 bytes per code
        clc
        adc row
        sta src
        lda #>font4
        adc #0
        sta src+1
        lda #0
        sta dst
        sta dst2
        lda row
        clc
        adc #>TBL_L
        sta dst+1
        lda row
        clc
        adc #>TBL_R
        sta dst2+1
        ldy #0
@code:  ldx #0
        lda (src,x)             ; glyph row in the high nibble
        sta (dst),y
        sta tmp
        lsr
        lsr
        lsr
        lsr
        sta (dst2),y
        sty tmp2
        tya
        ora #$80                ; the inverse, at code + 128
        tay
        lda tmp
        eor #$F0
        sta (dst),y
        lsr
        lsr
        lsr
        lsr
        sta (dst2),y
        ldy tmp2
        lda src
        clc
        adc #8
        sta src
        bcc :+
        inc src+1
:       iny
        bpl @code
        inc row
        lda row
        cmp #8
        bne @row
        rts

MOVE_BITMAP = 1
MOVE_GROUP  = 2
.include "move.inc"
.include "font4x8.inc"
