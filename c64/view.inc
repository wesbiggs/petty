; PETTY - VIEW for the C64 client's screens: a full-screen picture, in multicolour (Koala Painter)
; or hi-res (Art Studio, Doodle!), loaded with POKE into the bitmap at $6000, its colours
; at $5C00 and (multicolour) colour RAM, in the VIC's second bank.
;
; VIEW mode bg: LOAD (1, multicolour) or LOAD_HIRES (3) blanks the screen in colour bg
; and sets the VIC up for the picture; SHOW (2) shows it; TERMINAL (0) goes back to the
; terminal screen (the bridge then redraws it all). Sprites are hidden while a picture is
; up, and come back after.
;
; view_cr1 and view_mem hold what the terminal screen has in $D011 and $D018 (set by
; main.s when a screen comes on).

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
        lda view_cr1
        sta VIC_CR1
        lda view_mem
        sta VIC_MEM
        lda #$C8                ; no multicolour, 40 columns
        sta VIC_CR2
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
        jmp cmdloop

view_mode:  .byte 0
view_on:    .byte 0             ; a picture is up
view_spr:   .byte 0             ; the sprites that were on
