; PETTY - the C64 client's soft 53-column screen: 53x25 in the bitmap with a 6x8 font,
; display 4 (c64-53)
;
; One of the client's four screens (main.s assembles it in a scope). Characters are 6
; pixels wide, so 4 of them fill 3 bitmap cells (24 pixels), and the middle two straddle
; a cell boundary: character 4g+p of a row is drawn in phase p of group g. Column 52 is
; alone in cell 39, whose last 2 pixels stay blank. A cell holds one colour; the bridge
; sends the 4 characters of a group the same colour, and hardware sprites (SPRITE) that
; repaint the characters that lost theirs. Only non-space characters set colours (of
; every cell they touch), so writing a space never recolours its neighbours. Underline,
; sprites, MOVE (groups of 4 columns, 3 cells) and inline images are as on the soft
; 80-column screen.
;
; Memory: six glyph tables of 2K, built when the screen comes on, at $A000-$BFFF (under
; BASIC's ROM, switched out), $4000 (in the VIC's bank, unused by it) and $C100; and as
; the soft 80-column screen: the game's sprite shapes $4800-$57FF, the colour sprites'
; data $5800-$59FF, cell colours $5C00 (sprite pointers $5FF8), bitmap $6000-$7F3F.

; --- hardware ---------------------------------------------------------------
; Glyph tables, 8 pages each: row r of screen code c at table + r * 256 + c,
; codes 128-255 inverted. G is the glyph row in the top 6 bits.
; Under BASIC's ROM (switched out), in the VIC's bank before the game's sprite shapes,
; and after the game's variables.
TBL_0       = $A000             ; phase 0: G, in cell 0
TBL_1A      = $A800             ; phase 1: G >> 6, in cell 0's last 2 pixels
TBL_1B      = $B000             ;          G << 2, in cell 1's first 4
TBL_2A      = $B800             ; phase 2: G >> 4, in cell 1's last 4
TBL_2B      = $4000             ;          G << 4, in cell 2's first 2
TBL_3       = $C100             ; phase 3: G >> 2, in cell 2's last 6
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

COLS        = 53
ROWS        = 25
SPACE       = 32

; --- zero page (BASIC's area; BASIC is not running) -------------------------
bp          = $FB               ; bitmap address of the current group's first cell
cp          = $FD               ; colour address of the same
src         = $10
dst         = $12
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
col         = $28               ; the write position's column
tmp         = $29
tmp2        = $2A
sn          = $2B               ; SPRITE: number, column, row, data index
scol        = $2C
srow        = $2D
sidx        = $2E
inv         = $2F               ; init_tables: 0, or $FC for the inverse half

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

; The glyph's 8 rows into the cell at bp + y0, keeping the pixels in `keep`; the bottom
; row underlined (uline) in the pixels it draws.
.macro DRAW y0, keep, table
        ldy #y0
.repeat 7, r
        lda (bp),y
        and #keep
        ora table + r * 256,x
        sta (bp),y
        iny
.endrep
        lda uline
        and #<~keep
        ora table + 7 * 256,x
        sta tmp2
        lda (bp),y
        and #keep
        ora tmp2
        sta (bp),y
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

MOVE_BITMAP = 1
MOVE_GROUP  = 4
.include "move.inc"
.include "font6x8.inc"
