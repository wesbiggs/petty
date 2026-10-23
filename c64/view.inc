; PETTY - VIEW for the C64 clients: a full-screen picture, in multicolour (Koala Painter)
; or hi-res (Art Studio, Doodle!), loaded with POKE into the bitmap at $6000, its colours
; at $5C00 and (multicolour) colour RAM, in the VIC's second bank.
;
; VIEW mode bg: LOAD (1, multicolour) or LOAD_HIRES (3) blanks the screen in colour bg
; and sets the VIC up for the picture; SHOW (2) shows it; TERMINAL (0) goes back to the
; terminal screen (the bridge then redraws it all). Sprites are hidden while a picture is
; up, and come back after.
;
; The includer says what its terminal screen is: VIEW_TERM_CR1 and VIEW_TERM_MEM ($D011
; and $D018), and VIEW_BANK0 = 1 if it is in the VIC's first bank (the text client); or,
; with VIEW_VARS defined (the combined client), has them in view_cr1 and view_mem.

VIEW_TERMINAL = 0
VIEW_LOAD   = 1
VIEW_SHOW   = 2
VIEW_LOAD_HIRES = 3
VIEW_SCREEN = $5C00
VIEW_BITMAP = $6000

op_view:
        jsr rb_get
        sta view_mode
        jsr rb_get              ; bg
        ldx view_mode
        cpx #VIEW_LOAD
        beq @load
        cpx #VIEW_LOAD_HIRES
        beq @load
        cpx #VIEW_SHOW
        bne @term
        lda #$3B                ; the bitmap, screen on
        sta VIC_CR1
        jmp cmdloop
@term:
.ifdef VIEW_VARS
        lda view_cr1
        sta VIC_CR1
        lda view_mem
.else
        lda #VIEW_TERM_CR1
        sta VIC_CR1
        lda #VIEW_TERM_MEM
.endif
        sta VIC_MEM
        lda #$C8                ; no multicolour, 40 columns
        sta VIC_CR2
.if VIEW_BANK0
        lda CIA2_PRA            ; VIC bank 0
        ora #$03
        sta CIA2_PRA
.endif
        lda view_on
        beq :+
        lda view_spr            ; the sprites as they were
        sta SPR_ON
        lda #0
        sta view_on
:       jmp cmdloop
@load:  sta BORDER
        sta VIC_BG
        lda view_on
        bne :+
        lda SPR_ON
        sta view_spr
        lda #0
        sta SPR_ON
        inc view_on
:       lda #$2B                ; bitmap, screen off (the border colour) while it loads
        sta VIC_CR1
        lda #$D8                ; multicolour
        cpx #VIEW_LOAD
        beq :+
        lda #$C8                ; hi-res
:       sta VIC_CR2
        lda #((VIEW_SCREEN & $3FFF) / $400) << 4 | ((VIEW_BITMAP & $3FFF) / $2000) << 3
        sta VIC_MEM
.if VIEW_BANK0
        lda CIA2_PRA            ; VIC bank 1, $4000-$7FFF
        and #$FC
        ora #$02
        sta CIA2_PRA
.endif
        jmp cmdloop

view_mode:  .byte 0
view_on:    .byte 0             ; a picture is up
view_spr:   .byte 0             ; the sprites that were on
