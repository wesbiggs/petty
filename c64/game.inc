; PETTY - game hardware for the C64 text client: hardware sprites, a SID script
; player and a rectangle move, for a program that wants more than a terminal.
; Included by main.s after sound.inc. Wire format: bridge/src/protocol.js; what
; a program sends: bridge/src/game.js (OSC 8348 sprites, OSC 8349 SID).
;
; A raster interrupt at line 251 (below the last text row, so nothing is
; drawn half and half) ticks two things, once a frame:
;   - glides: a sprite moves by (dx, dy) pixels a frame for n frames, so the
;     bridge need not send a position every frame over a 3.8 KB/s link;
;   - scripts: up to four channels read records of SID register writes
;     from RAM and wait the frames each says.
; It is chained in front of the KERNAL's interrupt, which still keeps the
; keyboard and the jiffy clock. While a sound plays (sound.inc) interrupts
; are off, so everything here simply waits.
;
; Memory: sprite shapes, 64 slots of 64 bytes, in the VIC's bank: at $2000-$2FFF
; (the text client; clear of the character ROM's image at $1000 and below the
; receive buffer at $3700) or $4800-$57FF (the hi-res one, after its font). Script
; data goes where the bridge POKEs it, $9000-$BFFF; variables are at $C000.
; MOVE is the one part that differs: the hi-res client copies bitmap bytes.
;
; A script is records: n, (reg, value) * n, delay. The writes happen, then
; the next record waits `delay` frames (0: carry on at once). n = $FF ends
; the script, n = $FE lo hi jumps to that address (a loop). Writes to
; registers outside the channel's mask (one bit a SID register, 25 of them)
; are dropped, so music on voices 1-2 and an effect on voice 3 cannot
; disturb each other.

OP_SPRDEF   = 18                ; slot d1..d63
OP_SPR      = 19                ; n slot color flags xlo y
OP_GLIDE    = 20                ; n frames dx dy
OP_MOVE     = 21                ; x y w h dx dy
OP_SIDW     = 22                ; n (reg value)*n
OP_SIDPLAY  = 23                ; ch addr_lo addr_hi m0 m1 m2 m3
OP_SIDSTOP  = 24                ; ch (255: all)
OP_SIDRESET = 25
OP_SPRMC    = 26                ; c1 c2
GAME_OPS    = 27                ; opcodes below this are known

MSG_GLIDE   = 9                 ; every glide has finished

GV          = $C000             ; variables
gl_frames   = GV                ; 8 each: frames left, dx, dy
gl_dx       = GV + 8
gl_dy       = GV + 16
ch_on       = GV + 24           ; 4 each
ch_wait     = GV + 28
ch_plo      = GV + 32
ch_phi      = GV + 36
ch_mask     = GV + 40           ; 16: m0..m3 for each channel
gmask       = GV + 56           ; the mask being worked on
gflags      = GV + 60
gbm         = GV + 61
gbmi        = GV + 62
gch         = GV + 63
gcnt        = GV + 64
greg        = GV + 65
gval        = GV + 66
ggrd        = GV + 67
gl_fin      = GV + 68           ; a glide ended since the last tick
gl_done     = GV + 69           ; for the main loop to report
gold        = GV + 70           ; 2: the KERNAL's interrupt vector
mx          = GV + 72
my          = GV + 73
mw          = GV + 74
mh          = GV + 75
mdx         = GV + 76
mdy         = GV + 77
mdc         = GV + 78
mdr         = GV + 79
mr          = GV + 80
ma          = GV + 81           ; main-loop scratch (the interrupt has gch.. ggrd)
mb          = GV + 82
mc          = GV + 83
md          = GV + 84
mmask       = GV + 85           ; 4
mxo         = GV + 89           ; (hi-res MOVE) byte offsets: x * 8, the destination's, width * 8
mdo         = GV + 91
mw8         = GV + 93
GV_END      = GV + 95

gp          = $F7               ; script read pointer (BASIC's RS-232 pointers: unused)

.ifdef GAME_HIRES
SPR_BLOCKS  = $4800             ; in the VIC's second bank, after the font and before the colours
SPR_PTRS    = $5FF8             ; the colours at $5C00 are the "screen matrix"
SPR_PTR0    = $20               ; the pointer for the first block: (SPR_BLOCKS - $4000) / 64
.else
SPR_BLOCKS  = $2000
SPR_PTRS    = $07F8
SPR_PTR0    = $80
.endif
VIC_SPRX    = $D000
VIC_SPRXMSB = $D010
VIC_YEXP    = $D017
VIC_PRIO    = $D01B
VIC_MCOL    = $D01C
VIC_XEXP    = $D01D
VIC_SPRMC1  = $D025
VIC_SPRCOL  = $D027
VIC_IRQEN   = $D01A
VIC_IRQFLG  = $D019
VIC_CTRL1   = $D011
RASTER_LINE = 251

; --- setup -------------------------------------------------------------------

; Called once with interrupts off.
game_init:
        lda #0
        ldx #GV_END - GV
:       sta GV - 1,x
        dex
        bne :-
        lda $0314
        sta gold
        lda $0315
        sta gold+1
        lda #<game_irq
        sta $0314
        lda #>game_irq
        sta $0315
        lda #RASTER_LINE
        sta VIC_RASTER
        lda VIC_CTRL1
        and #$7F                ; bit 8 of the raster line
        sta VIC_CTRL1
        lda #1
        sta VIC_IRQFLG
        rts

; The raster interrupt is only on once something needs it (a glide or a script).
game_irq_on:
        lda #1
        sta VIC_IRQEN
        rts

game_irq:
        lda VIC_IRQFLG
        and #1
        beq @kernal
        sta VIC_IRQFLG          ; acknowledge the raster interrupt only
        jsr game_tick
        jmp $EA81               ; the KERNAL's way out: pull Y, X, A, RTI
@kernal:
        jmp (gold)

game_tick:
        jsr glide_tick
        jmp sid_tick

; Once from the main loop (keypoll): tell the bridge that the glides ended.
game_poll:
        lda gl_done
        beq @out
        lda #0
        sta gl_done
        lda #MSG_GLIDE
        jmp send
@out:   rts

; --- sprites -----------------------------------------------------------------

bitmask:
        .byte 1, 2, 4, 8, 16, 32, 64, 128

glide_tick:
        ldy #7
@spr:   lda gl_frames,y
        beq @next
        sec
        sbc #1
        sta gl_frames,y
        bne :+
        lda #1
        sta gl_fin
:       tya
        asl
        tax                     ; X = 2n, the sprite's register pair
        lda gl_dx,y
        clc
        adc VIC_SPRX,x
        sta VIC_SPRX,x
        lda gl_dx,y             ; carry out of the low byte: toggle bit 8 when
        bpl @pos                ; adding (carry set) or when subtracting (clear)
        bcs @y
        bcc @tog
@pos:   bcc @y
@tog:   lda VIC_SPRXMSB
        eor bitmask,y
        sta VIC_SPRXMSB
@y:     lda gl_dy,y
        clc
        adc VIC_SPRX+1,x
        sta VIC_SPRX+1,x
@next:  dey
        bpl @spr
        lda gl_fin
        beq @out
        ldy #7                  ; one just ended: are there more?
:       lda gl_frames,y
        bne @out
        dey
        bpl :-
        lda #0
        sta gl_fin
        lda #1
        sta gl_done
@out:   rts

; SPRDEF slot d1..d63
op_sprdef:
        jsr rb_get
        sta ma
        and #3
        lsr                     ; (slot and 3) * 64
        ror
        ror
        sta dst
        lda ma
        lsr
        lsr
        clc
        adc #>SPR_BLOCKS
        sta dst+1
        lda #63
        sta mb
        lda ma
        cmp #64
        bcs @skip               ; no such slot: eat the data
@loop:  jsr rb_get
        ldy #0
        sta (dst),y
        inc dst
        bne :+
        inc dst+1
:       dec mb
        bne @loop
        jmp cmdloop
@skip:  jsr rb_get
        dec mb
        bne @skip
        jmp cmdloop

.macro SETBIT reg, fbit
.local off, store
        lda gflags
        and #fbit
        beq off
        lda reg
        ora gbm
        bne store
off:    lda reg
        and gbmi
store:  sta reg
.endmacro

; SPR n slot color flags xlo y: flags bit 0 x bit 8, 1 on, 2 multicolour,
; 3 wide, 4 tall, 5 behind the text.
op_spr:
        jsr rb_get
        sta ma                  ; n
        jsr rb_get
        sta mb                  ; slot
        jsr rb_get
        sta mc                  ; colour
        jsr rb_get
        sta gflags
        jsr rb_get
        sta mx                  ; x, low byte
        jsr rb_get
        sta my                  ; y
        lda ma
        cmp #8
        bcc :+
        jmp cmdloop
:
        tay
        lda #0
        sta gl_frames,y         ; a position cancels the sprite's glide
        lda bitmask,y
        sta gbm
        eor #$FF
        sta gbmi
        lda mb
        and #63
        clc
        adc #SPR_PTR0
        sta SPR_PTRS,y
        lda mc
        sta VIC_SPRCOL,y
        tya
        asl
        tax
        lda mx
        sta VIC_SPRX,x
        lda my
        sta VIC_SPRX+1,x
        SETBIT VIC_SPRXMSB, 1
        SETBIT VIC_MCOL, 4
        SETBIT VIC_XEXP, 8
        SETBIT VIC_YEXP, 16
        SETBIT VIC_PRIO, 32
        SETBIT VIC_SPRITES, 2
spr_bad:   jmp cmdloop

; GLIDE n frames dx dy: move by (dx, dy) a frame, signed, for `frames` frames.
op_glide:
        jsr rb_get
        sta ma
        jsr rb_get
        sta mb
        jsr rb_get
        sta mc
        jsr rb_get
        sta md
        lda ma
        cmp #8
        bcs @bad
        tay
        jsr game_irq_on
        lda #0
        sta gl_frames,y         ; stopped while it is set up
        lda mc
        sta gl_dx,y
        lda md
        sta gl_dy,y
        lda mb
        sta gl_frames,y
@bad:   jmp cmdloop

op_sprmc:
        jsr rb_get
        sta VIC_SPRMC1
        jsr rb_get
        sta VIC_SPRMC1+1
        jmp cmdloop

; --- MOVE ----------------------------------------------------------------------

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
.ifdef GAME_HIRES
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

.ifdef GAME_HIRES
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

; --- SID ---------------------------------------------------------------------

; A = channel: its mask into gmask. Clobbers X, Y.
load_mask:
        asl
        asl
        tay
        ldx #0
:       lda ch_mask,y
        sta gmask,x
        iny
        inx
        cpx #4
        bne :-
        rts

; A = SID register: not zero if gmask lets a script write it. Clobbers X, Y.
mask_test:
        pha
        lsr
        lsr
        lsr
        tay
        pla
        and #7
        tax
        lda gmask,y
        and bitmask,x
        rts

; The gate down on each voice that gmask covers.
silence:
        lda #4
        jsr @one
        lda #11
        jsr @one
        lda #18
@one:   sta greg
        jsr mask_test
        beq @no
        ldx greg
        lda #0
        sta SID,x
@no:    rts

gget:   ldy #0
        lda (gp),y
        inc gp
        bne :+
        inc gp+1
:       rts

sid_tick:
        ldx #3
@ch:    stx gch
        lda ch_on,x
        bne :+
        jmp @next
:
        lda ch_wait,x
        beq @run
        dec ch_wait,x
        beq @run
        jmp @next
@run:   lda ch_plo,x
        sta gp
        lda ch_phi,x
        sta gp+1
        txa
        jsr load_mask
        lda #64                 ; records in one frame, at most
        sta ggrd
@rec:   dec ggrd
        beq @yield
        jsr gget
        cmp #$FF
        beq @end
        cmp #$FE
        beq @jump
        sta gcnt
@pair:  lda gcnt
        beq @delay
        dec gcnt
        jsr gget
        sta greg
        jsr gget
        sta gval
        lda greg
        cmp #25
        bcs @pair
        jsr mask_test
        beq @pair
        ldx greg
        lda gval
        sta SID,x
        jmp @pair
@delay: jsr gget
        ldx gch
        sta ch_wait,x
        cmp #0
        beq @rec
        bne @save
@yield: lda #1
        ldx gch
        sta ch_wait,x
@save:  ldx gch
        lda gp
        sta ch_plo,x
        lda gp+1
        sta ch_phi,x
        jmp @next
@jump:  jsr gget
        pha
        jsr gget
        sta gp+1
        pla
        sta gp
        jmp @rec
@end:   ldx gch
        lda #0
        sta ch_on,x
@next:  ldx gch
        dex
        bmi :+
        jmp @ch
:       rts

; SIDW n (reg value)*n: write now, whatever the masks say.
op_sidw:
        jsr rb_get
        sta ma
@pair:  lda ma
        beq @done
        dec ma
        jsr rb_get
        sta mb
        jsr rb_get
        ldx mb
        cpx #25
        bcs @pair
        sta SID,x
        jmp @pair
@done:  jmp cmdloop

; SIDPLAY ch addr_lo addr_hi m0 m1 m2 m3: start the script at addr on channel
; ch, restarting it if it was playing; its voices' gates go down first.
op_sidplay:
        jsr rb_get
        sta ma
        jsr rb_get
        sta mb
        jsr rb_get
        sta mc
        lda #0
        sta md
:       jsr rb_get
        ldx md                  ; (rb_get clobbers X and Y: the count is in md)
        sta mmask,x
        inc md
        lda md
        cmp #4
        bcc :-
        lda ma
        cmp #4
        bcs @bad
        jsr game_irq_on
        sei                     ; gmask, greg and the channel are the interrupt's too
        ldx ma
        lda #0
        sta ch_on,x
        txa
        asl
        asl
        tay
        ldx #0
:       lda mmask,x
        sta ch_mask,y
        sta gmask,x
        iny
        inx
        cpx #4
        bne :-
        jsr silence
        ldx ma
        lda mb
        sta ch_plo,x
        lda mc
        sta ch_phi,x
        lda #0
        sta ch_wait,x
        lda #1
        sta ch_on,x
        cli
@bad:   jmp cmdloop

; SIDSTOP ch: stop the channel and put its voices' gates down; 255 for all.
op_sidstop:
        jsr rb_get
        sta ma
        sei
        cmp #255
        bne @one
        ldx #3
:       stx ma
        jsr stop_ch
        ldx ma
        dex
        bpl :-
        cli
        jmp cmdloop
@one:   cmp #4
        bcs @bad
        tax
        jsr stop_ch
@bad:   cli
        jmp cmdloop

stop_ch:
        lda #0
        sta ch_on,x
        txa
        jsr load_mask
        jmp silence

; SIDRESET: every channel stopped, every SID register zero.
op_sidreset:
        sei
        lda #0
        ldx #3
:       sta ch_on,x
        dex
        bpl :-
        ldx #24
:       sta SID,x
        dex
        bpl :-
        cli
        jmp cmdloop
