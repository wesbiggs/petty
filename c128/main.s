; PETTY - thin terminal client for the C128 in 80 columns
;
; The C64 client's protocol (bridge/src/protocol.js) on the VDC: 80x25
; characters, announced with HELLO_ON 1. Colours arrive as VDC attribute
; bytes (RGBI in bits 0-3), already mapped by the bridge. Runs at 2 MHz with
; the 40-column screen blanked, and sends raw key matrix codes 0-87, so the
; C128's extra keys (ESC, TAB, ALT, keypad, ...) reach the bridge. Attribute
; bit 5 underlines, including spaces, bit 6 reverses the cell, and bit 7
; selects characters 256-511.
;
; VDC RAM: screen $0000, attributes $0800, font $2000-$3FFF (512 characters of
; 16 bytes: 0-127 ROM lowercase + patches; the bridge loads 128-511 with
; GLYPH as it needs them).

; --- hardware ---------------------------------------------------------------
VDC_ADDR    = $D600             ; write: register number; read: bit 7 = ready
VDC_DATA    = $D601
MMU_CR      = $FF00             ; $00 = bank 15 with I/O, $01 = character ROM at $D000
SPEED       = $D030             ; bit 0: 2 MHz
VIC_CR1     = $D011             ; bit 4: 40-column display on
VIC_IRR     = $D019
BORDER      = $D020             ; (sound.inc flashes it while playing)
CIA1_ICR    = $DC0D

ACIA_DATA   = $DE00
ACIA_STATUS = $DE01
ACIA_CMD    = $DE02
ACIA_CTRL   = $DE03

ROMCHARS    = $D800             ; lowercase half of the character ROM
FONTBUF     = $3800             ; 1K: characters 0-127, built before upload
RBUF        = $3F00             ; 256-byte receive ring buffer

VDC_SCREEN  = $0000
VDC_ATTR    = $0800
VDC_FONT    = $2000
COLS        = 80
ROWS        = 25

; VDC registers
R_DISPHI    = 12                ; display start
R_CURSOR    = 10                ; bits 5-6: cursor mode (01 = off)
R_UPDHI     = 18                ; update address (auto-increments)
R_ATTRHI    = 20                ; attribute start
R_MODE      = 24                ; bit 7: block copy (1) or fill (0)
R_MODE2     = 25                ; bit 7: bitmap, bit 6: attributes on
R_COLORS    = 26                ; bits 0-3: background
R_FONT      = 28                ; bits 5-7: font address / $2000
R_ULINE     = 29                ; underline scan line
R_COUNT     = 30                ; block operation byte count; writing starts it
R_DATA      = 31
R_SRCHI     = 32                ; block copy source

; KERNAL. Interrupts enter through $FF05/$FF17, which save A, X, Y and the
; MMU configuration and select bank 15; $FF33 restores them and returns.
IRQVEC      = $0314
NMIVEC      = $0318
INT_RETURN  = $FF33
SCNKEY      = $FF9F
UDTIM       = $FFEA
JIFFY_LO    = $A2
NDX         = $D0               ; keyboard buffer length
KYNDX       = $D1               ; pending function key string length
SHFLG       = $D3               ; shift/C=/ctrl/alt flags
SFDX        = $D4               ; matrix code of held key, 88 = none
LOCKS       = $F7               ; $80 = no shift+C= toggle, $40 = no ctrl+S
NO_KEY      = 88

; protocol
OP_GOTO     = 1
OP_COLOR    = 2
OP_PUT      = 3
OP_REPEAT   = 4
OP_SCROLL   = 5
OP_COLORS   = 6
OP_CLS      = 7
OP_FRAME    = 8
OP_GLYPH    = 11
NUM_OPS     = 18                ; 16 and 17 (SOUND, PROBE) are in sound.inc
SOUND_C128  = 1

MSG_ACK     = 1
MSG_KEY     = 2
MSG_HELLO_ON = 4
DISPLAY_C128 = 1

REPEAT_DELAY = 20               ; jiffies before auto-repeat
REPEAT_RATE  = 3                ; jiffies between repeats

; --- zero page (BASIC's area; BASIC and its IRQ never run) ------------------
pos         = $10               ; write pointer, 0-1999
addr        = $12               ; VDC address for vdc_seek / vdc_copy target
src         = $14               ; VDC copy source; RAM pointer while building the font
cnt         = $16               ; byte count for vdc_fill / vdc_copy
dst         = $18
count       = $1A
rptr        = $1B               ; ring buffer read index
wptr        = $1C               ; ring buffer write index (NMI)
curattr     = $1D
lastjiffy   = $1E
lastkey     = $1F
repcnt      = $20
top         = $21
bot         = $22
lines       = $23
row         = $24
glyph       = $25
n           = $26
mode24      = $27               ; register 24 with the copy bit clear
tmp         = $28

; --- BASIC stub: 10 SYS7181 -------------------------------------------------
.segment "LOADADDR"
        .word $1C01

.segment "CODE"
        .word @next, 10
        .byte $9E, "7181", 0
@next:  .word 0

start:
        .assert start = 7181, error, "SYS address mismatch"
        sei
        lda #0
        sta MMU_CR
        jsr init_vdc
        jsr init_font
        jsr init_screen
        jsr sound_init
        lda #0
        sta rptr
        sta wptr
        lda #NO_KEY
        sta lastkey
        lda #$C0
        sta LOCKS
        lda #<irq
        sta IRQVEC
        lda #>irq
        sta IRQVEC+1
        lda #<nmi
        sta NMIVEC
        lda #>nmi
        sta NMIVEC+1
        lda VIC_CR1             ; the VIC shows garbage at 2 MHz: blank it
        and #$EF
        sta VIC_CR1
        lda #1
        sta SPEED
        jsr init_acia
        cli
        jsr dial                ; through a WiFi modem, if built with DIAL
        lda #MSG_HELLO_ON
        jsr send
        lda #DISPLAY_C128
        jsr send

; --- main loop: decode commands forever ------------------------------------
cmdloop:
        jsr keypoll
        jsr rb_get
        cmp #NUM_OPS
        bcs cmdloop
        asl
        tax
        lda optable+1,x
        pha
        lda optable,x
        pha
        rts

optable:
        .word cmdloop-1, op_goto-1, op_color-1, op_put-1, op_repeat-1
        .word op_scroll-1, op_colors-1, op_cls-1, op_frame-1
        .word cmdloop-1, cmdloop-1, op_glyph-1    ; no SPRITE, NOSPRITE here
        .word cmdloop-1, cmdloop-1, cmdloop-1, op_poke-1
        .word op_sound-1, op_probe-1

op_goto:
        jsr rb_get
        cmp #ROWS
        bcc :+
        lda #ROWS-1
:       sta row
        jsr rb_get              ; clobbers X
        cmp #COLS
        bcc :+
        lda #COLS-1
:       ldx row
        clc
        adc rowlo,x
        sta pos
        lda rowhi,x
        adc #0
        sta pos+1
        jmp cmdloop

op_color:
        jsr rb_get
        sta curattr
        jmp cmdloop

; PUT n g1..gn: stream the characters, then fill their attributes.
op_put:
        jsr rb_get
        beq @done
        sta n
        sta count
        jsr seek_screen
        ldx #R_DATA
        stx VDC_ADDR
@loop:  jsr rb_get
:       bit VDC_ADDR
        bpl :-
        sta VDC_DATA
        dec count
        bne @loop
        jsr seek_attr
        jsr cnt_n
        lda curattr
        jsr vdc_fill
        jsr advance
@done:  jmp cmdloop

op_repeat:
        jsr rb_get
        sta n
        jsr rb_get
        sta glyph
        lda n
        beq @done
        jsr seek_screen
        jsr cnt_n
        lda glyph
        jsr vdc_fill
        jsr seek_attr
        jsr cnt_n
        lda curattr
        jsr vdc_fill
        jsr advance
@done:  jmp cmdloop

; COLORS border bg: the VDC has no border, only a background.
op_colors:
        jsr rb_get
        jsr rb_get
        and #$0F
        sta tmp
        ldx #R_COLORS
        jsr vdc_get
        and #$F0
        ora tmp
        jsr vdc_set
        jmp cmdloop

op_cls:
        jsr clear_screen
        jmp cmdloop

op_frame:
        lda #MSG_ACK
        jsr send
        jmp cmdloop

; POKE lo hi n d1..dn: n bytes (0 = 256) from lo + 256 * hi on (sound's tables).
op_poke:
        jsr rb_get
        sta dst
        jsr rb_get
        sta dst+1
        jsr rb_get
        sta count
@loop:  jsr rb_get
        ldy #0
        sta (dst),y
        inc dst
        bne :+
        inc dst+1
:       dec count
        bne @loop
        jmp cmdloop

; GLYPH lo hi d0..d7: the first 8 of character lo + 256 * hi's 16 bytes.
op_glyph:
        jsr rb_get              ; addr = VDC_FONT + code * 16
        sta addr
        lsr
        lsr
        lsr
        lsr
        sta addr+1
        jsr rb_get
        asl
        asl
        asl
        asl
        ora addr+1
        clc
        adc #>VDC_FONT
        sta addr+1
        lda addr
        asl
        asl
        asl
        asl
        sta addr
        jsr vdc_seek
        lda #8
        sta count
:       jsr rb_get
        ldx #R_DATA
        jsr vdc_set
        dec count
        bne :-
        jmp cmdloop

; SCROLL top bot n: rows top..bot move up n, vacated rows cleared. Uses the
; VDC's block copy and fill; the write pointer is unchanged.
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
        ldx top                 ; copy rows top+n.. to top..
        lda rowlo,x
        sta addr
        lda rowhi,x
        sta addr+1
        txa
        clc
        adc lines
        tax
        lda rowlo,x
        sta src
        lda rowhi,x
        sta src+1
        ldx row
        jsr cnt_rows
        jsr vdc_copy
        lda addr+1              ; and their attributes
        clc
        adc #>VDC_ATTR
        sta addr+1
        lda src+1
        clc
        adc #>VDC_ATTR
        sta src+1
        ldx row
        jsr cnt_rows
        jsr vdc_copy
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
        lda rowlo,x
        sta addr
        lda rowhi,x
        sta addr+1
        jsr vdc_seek
        ldx row
        jsr cnt_rows
        lda #32
        jsr vdc_fill
        lda addr+1
        clc
        adc #>VDC_ATTR
        sta addr+1
        jsr vdc_seek
        ldx row
        jsr cnt_rows
        lda curattr
        jsr vdc_fill
@done:  jmp cmdloop

clear_screen:
        lda #0
        sta pos
        sta pos+1
        jsr seek_screen
        ldx #ROWS
        jsr cnt_rows
        lda #32
        jsr vdc_fill
        jsr seek_attr
        ldx #ROWS
        jsr cnt_rows
        lda curattr
        jmp vdc_fill

; pos += n, wrapping at the end of the screen like the C64's pointer. A
; PUT or REPEAT never runs past the end, so wrapping afterwards is enough.
advance:
        lda pos
        clc
        adc n
        sta pos
        bcc :+
        inc pos+1
:       lda pos+1
        cmp #>(COLS*ROWS)
        bcc @out
        bne @wrap
        lda pos
        cmp #<(COLS*ROWS)
        bcc @out
@wrap:  lda pos
        sec
        sbc #<(COLS*ROWS)
        sta pos
        lda pos+1
        sbc #>(COLS*ROWS)
        sta pos+1
@out:   rts

cnt_n:
        lda n
        sta cnt
        lda #0
        sta cnt+1
        rts

; cnt = X rows of bytes.
cnt_rows:
        lda rowlo,x
        sta cnt
        lda rowhi,x
        sta cnt+1
        rts

; --- VDC ---------------------------------------------------------------------

; A -> VDC register X. Keeps X.
vdc_set:
        stx VDC_ADDR
:       bit VDC_ADDR
        bpl :-
        sta VDC_DATA
        rts

; VDC register X -> A. Keeps X.
vdc_get:
        stx VDC_ADDR
:       bit VDC_ADDR
        bpl :-
        lda VDC_DATA
        rts

; A -> the data register, which must already be selected.
vdc_write:
:       bit VDC_ADDR
        bpl :-
        sta VDC_DATA
        rts

seek_screen:
        lda pos
        sta addr
        lda pos+1
        sta addr+1
        jmp vdc_seek

seek_attr:
        lda pos
        sta addr
        lda pos+1
        clc
        adc #>VDC_ATTR
        sta addr+1
        ; fall through

; Update address = addr.
vdc_seek:
        ldx #R_UPDHI
        lda addr+1
        jsr vdc_set
        inx
        lda addr
        jmp vdc_set

; Write A to cnt (1-65535) bytes from the update address on.
vdc_fill:
        pha
        ldx #R_MODE
        lda mode24
        jsr vdc_set
        pla
        ldx #R_DATA
        jsr vdc_set             ; the first byte is a normal write
        lda cnt                 ; the block fill repeats it cnt-1 times
        bne :+
        dec cnt+1
:       dec cnt
        jmp vdc_block

; Copy cnt (1-65535) bytes from VDC address src to addr.
vdc_copy:
        jsr vdc_seek
        ldx #R_SRCHI
        lda src+1
        jsr vdc_set
        inx
        lda src
        jsr vdc_set
        ldx #R_MODE
        lda mode24
        ora #$80
        jsr vdc_set
        ; fall through

; Run the block operation set up in register 24 over cnt bytes, at most 255
; at a time (a count of 0 would mean 256). Both addresses carry on.
vdc_block:
        ldx #R_COUNT
@loop:  lda cnt+1
        bne @big
        lda cnt
        beq @done
        jmp vdc_set
@big:   lda #255
        jsr vdc_set
        lda cnt
        sec
        sbc #255
        sta cnt
        bcs @loop
        dec cnt+1
        jmp @loop
@done:  rts

; --- serial ------------------------------------------------------------------

; Next received byte in A, flags set from it; polls the keyboard while
; waiting. Clobbers X, Y.
rb_get:
        ldx rptr
        cpx wptr
        bne :+
        jsr keypoll
        jmp rb_get
:       inc rptr                ; before the load, so Z/N reflect the byte
        lda RBUF,x
        rts

; Transmit A (waits for the transmit register to empty).
send:
        pha
:       lda ACIA_STATUS
        and #$10
        beq :-
        pla
        sta ACIA_DATA
        rts

nmi:
        lda ACIA_STATUS         ; also acknowledges the interrupt
        and #$08                ; receive register full?
        beq :+
        lda ACIA_DATA
        ldx wptr
        sta RBUF,x
        inc wptr
:       jmp INT_RETURN

init_acia:
        sta ACIA_STATUS         ; programmed reset
        lda #%00011111          ; 1 stop, 8 bits, internal clock, 19200 (38400 on SwiftLink)
        sta ACIA_CTRL
        lda #%00001001          ; no parity, RTS low, TX irq off, RX irq on, DTR on
        sta ACIA_CMD
        lda ACIA_DATA           ; discard anything pending
        rts

.include "dial.inc"

; --- keyboard ----------------------------------------------------------------

; Replaces the KERNAL's IRQ handler: no screen editor or BASIC, just the
; keyboard scan and the jiffy clock.
irq:
        lda VIC_IRR             ; acknowledge the raster interrupt
        sta VIC_IRR
        lda CIA1_ICR            ; and CIA 1, in case it was the source
        jsr SCNKEY
        jsr UDTIM
        jmp INT_RETURN

; Once per jiffy: send KEY for new presses and auto-repeats. Clobbers A.
keypoll:
        lda JIFFY_LO
        cmp lastjiffy
        beq @out
        sta lastjiffy
        lda #0
        sta NDX                 ; we read the matrix, not the KERNAL buffer
        sta KYNDX
        lda SFDX
        cmp #NO_KEY
        beq @none
        cmp lastkey
        bne @new
        dec repcnt
        bne @out
        lda #REPEAT_RATE
        sta repcnt
        bne @send
@new:   sta lastkey
        lda #REPEAT_DELAY
        sta repcnt
@send:  lda #MSG_KEY
        jsr send
        lda lastkey
        jsr send
        lda SHFLG
        and #$0F                ; shift, C=, ctrl, alt
        jsr send
@out:   rts
@none:  sta lastkey
        rts

; --- setup -------------------------------------------------------------------

; Screen at $0000, attributes at $0800, font at $2000, text mode with
; attributes, underline on the bottom row of the 8x8 glyphs, no cursor, black
; background.
init_vdc:
        ldx #R_MODE
        jsr vdc_get
        and #$3F                ; block fill, screen not reversed
        sta mode24
        jsr vdc_set
        ldx #R_DISPHI
        lda #>VDC_SCREEN
        jsr vdc_set
        inx
        lda #<VDC_SCREEN
        jsr vdc_set
        ldx #R_ATTRHI
        lda #>VDC_ATTR
        jsr vdc_set
        inx
        lda #<VDC_ATTR
        jsr vdc_set
        ldx #R_FONT
        jsr vdc_get
        and #$1F
        ora #>VDC_FONT
        jsr vdc_set
        ldx #R_MODE2
        jsr vdc_get
        and #$7F
        ora #$40
        jsr vdc_set
        ldx #R_ULINE
        lda #7
        jsr vdc_set
        ldx #R_CURSOR
        lda #$20
        jsr vdc_set
        ldx #R_COLORS
        lda #$F0
        jmp vdc_set

init_screen:
        lda #14                 ; light grey
        sta curattr
        jsr clear_screen
        jsr seek_screen
        ldx #R_DATA
        stx VDC_ADDR
        ldx #0
:       lda banner,x
        beq :+
        jsr vdc_write
        inx
        bne :-
:       rts

; Screen codes for "petty: waiting for bridge..." (lowercase set).
banner:
        .byte 16,5,20,20,25,": ",23,1,9,20,9,14,7," ",6,15,18," ",2,18,9,4,7,5,"...",0

; Build characters 0-127 in FONTBUF from the ROM and the custom glyphs, then
; upload them to the VDC and clear 128-511. Called with interrupts off.
init_font:
        lda #$01                ; character ROM at $D000
        sta MMU_CR
        ldx #0
:       lda ROMCHARS,x
        sta FONTBUF,x
        lda ROMCHARS+$100,x
        sta FONTBUF+$100,x
        lda ROMCHARS+$200,x
        sta FONTBUF+$200,x
        lda ROMCHARS+$300,x
        sta FONTBUF+$300,x
        inx
        bne :-
        lda #0
        sta MMU_CR

        lda #<glyph_data        ; patch custom glyphs
        sta src
        lda #>glyph_data
        sta src+1
        ldx #0
@patch: cpx #NUM_GLYPHS
        beq @upload
        lda #0
        sta dst+1
        lda glyph_slots,x       ; dst = FONTBUF + slot * 8
        asl
        rol dst+1
        asl
        rol dst+1
        asl
        rol dst+1
        sta dst
        lda dst+1
        clc
        adc #>FONTBUF
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

@upload:
        lda #<VDC_FONT
        sta addr
        lda #>VDC_FONT
        sta addr+1
        jsr vdc_seek
        ldx #R_DATA
        stx VDC_ADDR
        lda #<FONTBUF
        sta src
        lda #>FONTBUF
        sta src+1
        lda #128
        sta count
@char:  ldy #0
:       lda (src),y             ; 8 rows of pixels
        jsr vdc_write
        iny
        cpy #8
        bne :-
        lda #0                  ; 8 unused rows of the 16-byte slot
:       jsr vdc_write
        iny
        cpy #16
        bne :-
        lda src
        clc
        adc #8
        sta src
        bcc :+
        inc src+1
:       dec count
        bne @char
        lda #<(384 * 16)        ; the update address is at character 128
        sta cnt
        lda #>(384 * 16)
        sta cnt+1
        lda #0
        jmp vdc_fill

; Row offsets, including row 25 (= a full screen of bytes).
rowlo:
.repeat ROWS+1, i
        .byte <(i * COLS)
.endrep
rowhi:
.repeat ROWS+1, i
        .byte >(i * COLS)
.endrep

.macro RX_PENDING target
        lda rptr
        cmp wptr
        bne target
.endmacro
.include "sound.inc"
.include "glyphs.inc"
