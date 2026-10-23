; PETTY - CELLS for the soft 80- and 53-column C64 clients: an inline image, as whole
; cells of the bitmap (8x8 pixels and a colour each), which the bridge lines up with the
; screen's groups of columns (2 columns a cell; 4 columns three cells).
;
; CELLS row cell n (d0..d7 colour)*n: n cells from cell `cell` (0-39) of text row `row`
; on, along the row. The write position stays where it is. Needs BITMAP, COLRAM,
; o320lo/hi, o40lo/hi; rb_get must keep X.

op_cells:
        jsr rb_get
        tax                     ; the row
        jsr rb_get
        sta count               ; the cell
        lda o40lo,x             ; src = COLRAM + row * 40 + cell
        clc
        adc count
        sta src
        lda o40hi,x
        adc #>COLRAM
        sta src+1
        lda #0                  ; dst = BITMAP + row * 320 + cell * 8
        sta dst+1
        lda count
        asl
        rol dst+1
        asl
        rol dst+1
        asl
        rol dst+1
        clc
        adc o320lo,x
        sta dst
        lda dst+1
        adc o320hi,x
        adc #>BITMAP
        sta dst+1
        jsr rb_get
        sta count               ; n
        beq @done
@cell:  ldx #0
@row:   jsr rb_get              ; rb_get clobbers Y: X counts the pixel rows
        pha
        txa
        tay
        pla
        sta (dst),y
        inx
        cpx #8
        bne @row
        jsr rb_get
        ldy #0
        sta (src),y
        lda dst
        clc
        adc #8
        sta dst
        bcc :+
        inc dst+1
:       inc src
        bne :+
        inc src+1
:       dec count
        bne @cell
@done:  jmp cmdloop
