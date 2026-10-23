; PETTY - MOVE for the C64 client's screens (game.inc), which differ in how: the text
; screen copies screen codes and colours, the bitmap ones bitmap bytes and colours
; (movebits.inc, in main.s). Each screen includes this, saying which with MOVE_BITMAP,
; and MOVE_GROUP: the columns a group of bitmap cells holds (1 on the 40-column screens;
; 2 columns a cell at 80 columns; 4 columns three cells at 53), as the soft screens move
; whole groups only.

; MOVE x y w h dx dy: the w by h cells (screen codes and colours) at x, y
; copy to x + dx, y + dy (dx and dy signed), as if all at once. A rectangle
; that does not fit on the screen, before or after, does nothing.
op_move:
        jsr rb_get
        sta mx
        jsr rb_get
        sta my
        jsr rb_get
        sta mw
        jsr rb_get
        sta mh
        jsr rb_get
        sta mdx
        jsr rb_get
        sta mdy
.if MOVE_GROUP > 1
        lda mx                  ; whole groups only, then counted in bitmap cells
        ora mw
        ora mdx
        and #MOVE_GROUP - 1
        beq :+
        jmp @bad
:
        lda mx
        jsr move_cells
        sta mx
        lda mw
        jsr move_cells
        sta mw
        lda mdx                 ; signed: shift right keeping the sign
        cmp #$80
        ror
.if MOVE_GROUP = 4
        cmp #$80
        ror
        sta ma                  ; three cells a group
        asl
        clc
        adc ma
.endif
        sta mdx
.endif
        lda mw
        beq @bad
        lda mh
        beq @bad
        lda mx                  ; the sums below wrap past 255: bound each term first
        cmp #41
        bcs @bad
        lda mw
        cmp #41
        bcs @bad
        lda my
        cmp #26
        bcs @bad
        lda mh
        cmp #26
        bcs @bad
        lda mx                  ; the source: x + w <= 40, y + h <= 25
        clc
        adc mw
        cmp #41
        bcs @bad
        lda my
        clc
        adc mh
        cmp #26
        bcs @bad
        lda mx                  ; the destination, which must also be on the
        clc                     ; screen (a negative sum wraps past 255)
        adc mdx
        sta mdc
        cmp #40
        bcs @bad
        adc mw
        cmp #41
        bcs @bad
        lda my
        clc
        adc mdy
        sta mdr
        cmp #25
        bcs @bad
        adc mh
        cmp #26
        bcs @bad
.if MOVE_BITMAP
        jsr move_prep
.endif
        lda mdy                 ; rows: bottom first when moving down, so that
        bmi @fwd                ; a row is read before it is written over
        beq @fwd
        lda mh
        sta mr
:       dec mr
        jsr move_row
        lda mr
        bne :-
@bad:   jmp cmdloop
@fwd:   lda #0
        sta mr
:       jsr move_row
        inc mr
        lda mr
        cmp mh
        bcc :-
        jmp cmdloop

.if MOVE_GROUP > 1
; A (whole groups of columns) as bitmap cells.
move_cells:
        lsr
.if MOVE_GROUP = 4
        lsr
        sta ma
        asl
        adc ma                  ; (C clear: A was at most 127)
.endif
        rts
.endif

.if MOVE_BITMAP
.else
; Row mr of the rectangle.
move_row:
        lda my
        clc
        adc mr
        tax
        jsr set_src_row
        lda mdr
        clc
        adc mr
        tax
        jsr set_dst_row
        lda src                 ; to the first cell of each row
        clc
        adc mx
        sta src
        sta srcc
        lda src+1
        adc #0
        sta src+1
        clc
        adc #>(COLRAM-SCREEN)
        sta srcc+1
        lda dst
        clc
        adc mdc
        sta dst
        sta dstc
        lda dst+1
        adc #0
        sta dst+1
        clc
        adc #>(COLRAM-SCREEN)
        sta dstc+1
        lda mdy                 ; along a row, backwards if it moves right
        bne @fwd                ; (rows apart never overlap)
        lda mdx
        bmi @fwd
        beq @fwd
        ldy mw
:       dey
        lda (src),y
        sta (dst),y
        lda (srcc),y
        sta (dstc),y
        tya
        bne :-
        rts
@fwd:   ldy #0
:       lda (src),y
        sta (dst),y
        lda (srcc),y
        sta (dstc),y
        iny
        cpy mw
        bcc :-
        rts

.endif
