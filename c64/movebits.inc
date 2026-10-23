; PETTY - MOVE on the C64's bitmap screens (move.inc): the rows of the rectangle, as
; bitmap bytes and colours. Needs BITMAP, COLRAM, o320lo/hi, o40lo/hi and copy (main.s).

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
