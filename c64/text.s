; PETTY - the C64 client's text screen: 40x25 characters, display 0 (c64)
;
; One of the client's four screens (main.s assembles it in a scope; the receive ring,
; keyboard, dial, sound, game hardware, VIEW and POKE are the core's). The VIC uses its
; second bank, as on the bitmap screens: the character set at $4000 (0-127 the ROM's
; lowercase half with the custom glyphs patched over it, 128-255 their inverse), the
; game's sprite shapes at $4800-$57FF, and the screen at $5C00, where the bitmap screens
; keep their colours.

; --- hardware ---------------------------------------------------------------
COLRAM      = $D800
SCREEN      = $5C00
CHARSET     = $4000
VIC_MEM     = $D018
BORDER      = $D020
BGCOLOR     = $D021
VIC_CR1     = $D011
VIC_CR2     = $D016
CIA2_PRA    = $DD00             ; bits 0-1: VIC bank, inverted

; KERNAL
BLNSW       = $CC               ; cursor blink switch (nonzero = off)
MODE        = $0291             ; $80 = disable shift+C= charset toggle

MSG_ACK     = 1

; --- zero page (BASIC's area; BASIC is not running) -------------------------
; Clear of the core's ring pointers, keyboard state and tmp (main.s).
scr         = $FB               ; screen write pointer
colp        = $FD               ; colour write pointer (low byte == scr low)
src         = $10               ; generic pointers
dst         = $12
srcc        = $14
dstc        = $16
count       = $1C
curcolor    = $1D
top         = $23
bot         = $24
lines       = $25
row         = $26
glyph       = $27

; Opcodes 0-28 (main.s handles 27, MODE).
optable:
        .word cmdloop-1, op_goto-1, op_color-1, op_put-1, op_repeat-1
        .word op_scroll-1, op_colors-1, op_cls-1, op_frame-1
        .word cmdloop-1, cmdloop-1, cmdloop-1, cmdloop-1
        .word cmdloop-1, op_view-1, op_poke-1
        .word op_sound-1, op_probe-1
        .word op_sprdef-1, op_spr-1, op_glide-1, op_move-1
        .word op_sidw-1, op_sidplay-1, op_sidstop-1, op_sidreset-1, op_sprmc-1
        .word cmdloop-1, cmdloop-1      ; (MODE; CELLS, which the text screen does without)

op_goto:
        jsr rb_get
        cmp #25
        bcc :+
        lda #24
:       sta row
        jsr rb_get
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

; The dial's progress, and asking for its settings (dialask.inc), draw through this.
.if ::DIAL_DBGCODE              ; (:: as this is assembled in a scope)
; A = screen code, X = column, Y = row.
ui_cell:
        pha
        txa
        clc
        adc rowlo,y
        sta scr
        lda rowhi,y
        adc #0
        sta scr+1
        pla
        ldy #0
        sta (scr),y
        rts

ui_clear:
        jmp clear_screen
.endif

; --- setup -------------------------------------------------------------------

init_screen:
        lda CIA2_PRA            ; VIC bank 1, $4000-$7FFF
        and #$FC
        ora #$02
        sta CIA2_PRA
        lda #$1B                ; text, screen on, 25 rows
        sta VIC_CR1
        lda #$C8                ; no multicolour, 40 columns
        sta VIC_CR2
        lda #((SCREEN & $3FFF) / $400) << 4 | ((CHARSET & $3FFF) / $800) << 1
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

; Called with interrupts off, from main.s's copy of the ROM's font.
init_charset:
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

MOVE_BITMAP = 0
MOVE_GROUP  = 1
.include "move.inc"
