; PETTY - the C64 client's hi-res screen: 40x25 in the bitmap, display 3 (c64-hires)
;
; One of the client's four screens (main.s assembles it in a scope; the receive ring,
; keyboard, dial, sound, game hardware, VIEW and POKE are the core's). Each 8x8 cell has
; its own foreground and background (COLOR is foreground << 4 | background), so the
; character set needs no inverse half: screen codes 0-127 are the text screen's
; (lowercase ROM plus the custom glyphs), and the bridge loads 128-255 with GLYPH as it
; needs them. UNDERLINE sets the bottom pixel row of what is written next. BITS draws
; an inline image's cells at the write position.
;
; Memory (the VIC's second bank): font $4000-$47FF, the game's sprite shapes
; $4800-$57FF, cell colours $5C00, bitmap $6000-$7F3F.

; --- hardware ---------------------------------------------------------------
FONT        = $4000             ; 8 pages: row r of screen code c at FONT + r*256 + c
COLRAM      = $5C00             ; bitmap colours: high nibble fg, low nibble bg
BITMAP      = $6000

CIA2_PRA    = $DD00             ; bits 0-1: VIC bank, inverted

SPR_ON      = $D015
VIC_CR1     = $D011
VIC_CR2     = $D016
VIC_MEM     = $D018
BORDER      = $D020

; KERNAL
BLNSW       = $CC               ; cursor blink switch (nonzero = off)
MODE        = $0291             ; $80 = disable shift+C= charset toggle

MSG_ACK     = 1

COLS        = 40
ROWS        = 25

; --- zero page (BASIC's area; BASIC is not running) -------------------------
bp          = $FB               ; bitmap address of the current cell
cp          = $FD               ; colour address of the current cell
src         = $10
dst         = $12
cnt         = $16               ; 16-bit byte count for copy / fill
count       = $1C
curcolor    = $1D               ; foreground << 4 | background
top         = $23
bot         = $24
lines       = $25
row         = $26
glyph       = $27
tmp         = $29
tmp2        = $2A
uline       = $2B               ; $FF: underline what is written, else 0

; Opcodes 0-28 (main.s handles 27, MODE).
optable:
        .word cmdloop-1, op_goto-1, op_color-1, op_put-1, op_repeat-1
        .word op_scroll-1, op_colors-1, op_cls-1, op_frame-1
        .word op_sprite-1, op_nosprite-1, op_glyph-1, op_underline-1
        .word op_bits-1, op_view-1, op_poke-1
        .word op_sound-1, op_probe-1
        .word op_sprdef-1, op_spr-1, op_glide-1, op_move-1
        .word op_sidw-1, op_sidplay-1, op_sidstop-1, op_sidreset-1, op_sprmc-1
        .word cmdloop-1, cmdloop-1      ; (MODE; CELLS, which the hi-res screen does without: it has BITS)

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
        sta tmp
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
        rts

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
; until the bridge loads them. Called with interrupts off, from main.s's copy of the
; ROM's font.
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
        lda #<ROMCHARS
        sta src
        lda #>ROMCHARS
        sta src+1
        ldx #0
@rom:   jsr store_glyph
        inx
        bpl @rom

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

MOVE_BITMAP = 1
MOVE_GROUP  = 1
.include "move.inc"
