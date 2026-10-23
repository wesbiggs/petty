; PETTY - MOVE for the C64 text and hi-res clients (game.inc), which differ in how: the
; text client copies screen codes and colours, the hi-res one bitmap bytes and colours.
; MOVE_BITMAP says which (the combined client includes this once for each).

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

.if MOVE_BITMAP
; (hi-res) byte offsets: x * 8, the destination's, and the width * 8.
move_prep:
        lda #0                  ; byte offsets of the first cell in a row of cells: x * 8, the
        sta mxo+1               ; destination's, and the width * 8
        sta mdo+1
        sta mw8+1
        lda mx
        asl
        rol mxo+1
        asl
        rol mxo+1
        asl
        rol mxo+1
        sta mxo
        lda mdc
        asl
        rol mdo+1
        asl
        rol mdo+1
        asl
        rol mdo+1
        sta mdo
        lda mw
        asl
        rol mw8+1
        asl
        rol mw8+1
        asl
        rol mw8+1
        sta mw8
        rts

; Row mr of the rectangle: the bitmap bytes (8 a cell, contiguous along a row of
; cells) and then the colours.
move_row:
        lda my
        clc
        adc mr
        tax
        lda o320lo,x
        clc
        adc mxo
        sta src
        lda o320hi,x
        adc mxo+1
        clc
        adc #>BITMAP
        sta src+1
        lda mdr
        clc
        adc mr
        tax
        lda o320lo,x
        clc
        adc mdo
        sta dst
        lda o320hi,x
        adc mdo+1
        clc
        adc #>BITMAP
        sta dst+1
        lda mdy
        bne @fwd                ; (rows apart never overlap)
        lda mdx
        bmi @fwd
        beq @fwd
        lda src                 ; moving right along the row: cell by cell from the right
        clc
        adc mw8
        sta src
        lda src+1
        adc mw8+1
        sta src+1
        lda dst
        clc
        adc mw8
        sta dst
        lda dst+1
        adc mw8+1
        sta dst+1
        lda mw
        sta ma
@cell:  lda src
        sec
        sbc #8
        sta src
        bcs :+
        dec src+1
:       lda dst
        sec
        sbc #8
        sta dst
        bcs :+
        dec dst+1
:       ldy #7
:       lda (src),y
        sta (dst),y
        dey
        bpl :-
        dec ma
        bne @cell
        jmp @colours
@fwd:   lda mw8
        sta cnt
        lda mw8+1
        sta cnt+1
        jsr copy
@colours:
        lda my
        clc
        adc mr
        tax
        lda o40lo,x
        clc
        adc mx
        sta src
        lda o40hi,x
        adc #>COLRAM
        sta src+1
        lda mdr
        clc
        adc mr
        tax
        lda o40lo,x
        clc
        adc mdc
        sta dst
        lda o40hi,x
        adc #>COLRAM
        sta dst+1
        lda mdy
        bne @cfwd
        lda mdx
        bmi @cfwd
        beq @cfwd
        ldy mw
:       dey
        lda (src),y
        sta (dst),y
        tya
        bne :-
        rts
@cfwd:  ldy #0
:       lda (src),y
        sta (dst),y
        iny
        cpy mw
        bcc :-
        rts
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
