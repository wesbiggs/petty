; PETTY - the combined C64 client: the text, hi-res, soft 80-column and soft
; 53-column screens in one program, switched by the bridge (MODE)
;
; The four screens are the four clients' own code (main.s, mainhires.s,
; main80.s, main53.s), assembled here with MULTI defined: each in its own
; scope, without the parts they share, which are here once: the receive ring
; and the NMI, the keyboard, the dial, sound and the game hardware. The
; command loop dispatches through the current screen's opcode table.
;
; It starts on the text screen, which the dial (and DIALASK's settings screen)
; draws on, then switches to START_DISPLAY and says HELLO_ON with it, and
; MODES: the displays it can switch to. MODE display (from the bridge, between
; frames) switches: the screen is cleared, the sprites and the SID's scripts
; are stopped, and it says HELLO_ON and MODES again, for a full redraw. An id
; it has no screen for gets the HELLO_ON of the screen it is on.
;
; Memory (the VIC uses its second bank, $4000-$7FFF, on every screen):
;   $0801-$3FFF  the program
;   $4000-$4FFF  the screen's font: text and hi-res $4000-$47FF (with sprite shapes
;                $4800-$57FF), soft 80 columns its two tables
;   $5000-$51FF  soft 80 and 53 columns: the sprites that repaint colours
;   $5C00-$5FFF  the text screen, or the bitmap's colours; sprite pointers at $5FF8
;   $6000-$7F3F  the bitmap
;   $8000-$8FFF  the receive ring
;   $9000-$BFFF  game scripts (text, hi-res), or the soft 53-column tables (BASIC's
;                ROM is switched out)
;   $C000-$C05F  game variables; $C800-$CBFF the character ROM's lowercase half,
;                copied once; $CD00-$CFFF sound

MULTI       = 1

; --- hardware ---------------------------------------------------------------
RBUF        = $8000
RBUF_END    = $9000
ROMCHARS    = $C800             ; the screens' fonts are built from this copy of the ROM's
ROMFONT     = $D800             ; lowercase half, made while nothing can interrupt

ACIA_DATA   = $DE00
ACIA_STATUS = $DE01
ACIA_CMD    = $DE02
ACIA_CTRL   = $DE03

CIA2_PRA    = $DD00             ; bits 0-1: VIC bank, inverted
SPR_ON      = $D015
SPR_YEXP    = $D017
SPR_PRIO    = $D01B
SPR_MULTI   = $D01C
SPR_XEXP    = $D01D
VIC_CR1     = $D011
VIC_CR2     = $D016
VIC_MEM     = $D018
BORDER      = $D020
BGCOLOR     = $D021
VIC_BG      = $D021

; KERNAL
NMIVEC      = $0318
JIFFY_LO    = $A2
KEYCOUNT    = $C6               ; keyboard buffer length
CURKEY      = $CB               ; matrix code of held key, 64 = none
STOP_KEY    = 63                ; ...of RUN/STOP
BLNSW       = $CC               ; cursor blink switch (nonzero = off)
SHFLAG      = $028D             ; shift/C=/ctrl flags
MODE        = $0291             ; $80 = disable shift+C= charset toggle

; protocol
OP_MODE     = 27                ; display
NUM_OPS_MULTI = 27              ; the screens' tables: opcodes below OP_MODE
MSG_ACK     = 1
MSG_KEY     = 2
MSG_HELLO_ON = 4
MSG_MODES   = 10

DISPLAY_C64 = 0
DISPLAY_C64_80 = 2
DISPLAY_C64_HIRES = 3
DISPLAY_C64_53 = 4
MODES_MASK  = $80 | 1 << DISPLAY_C64 | 1 << DISPLAY_C64_80 | 1 << DISPLAY_C64_HIRES | 1 << DISPLAY_C64_53
.include "start.inc"            ; START_DISPLAY, from make START=...

REPEAT_DELAY = 20               ; jiffies before auto-repeat
REPEAT_RATE  = 3                ; jiffies between repeats

; --- zero page (BASIC's area; BASIC is not running) -------------------------
; The screens' own are theirs while they are on; these are the ones they share.
src         = $10
dst         = $12
cnt         = $16
rp          = $18               ; ring buffer read pointer
wp          = $1A               ; ring buffer write pointer (NMI)
count       = $1C               ; (count, top and bot: dialask.inc's line editor)
lastjiffy   = $20
lastkey     = $21
repcnt      = $22
top         = $23
bot         = $24
tmp         = $29
optab       = $3A               ; the screen's opcode table

CLIENT_ASK  = 1                 ; this client can ask for the dial's settings (dialask.inc)

; --- BASIC stub: 10 SYS2061 -------------------------------------------------
.segment "LOADADDR"
        .word $0801

.segment "CODE"
        .word @next, 10
        .byte $9E, "2061", 0
@next:  .word 0

start:
        .assert start = 2061, error, "SYS address mismatch"
        sei
        lda #$36                ; BASIC's ROM out: RAM at $A000-$BFFF (the soft 53-column tables)
        sta $01
        jsr copy_rom_font
        lda #DISPLAY_C64        ; the dial draws on the text screen
        jsr set_screen
        jsr sound_init
        jsr game_init
        lda #<RBUF
        sta rp
        sta wp
        lda #>RBUF
        sta rp+1
        sta wp+1
        lda #64
        sta lastkey
        lda #<nmi
        sta NMIVEC
        lda #>nmi
        sta NMIVEC+1
        jsr init_acia
        cli
        jsr dial                ; through a WiFi modem, if built with DIAL
        lda #START_DISPLAY
        cmp display
        beq :+
        jsr set_screen
:       jsr hello

; --- main loop: decode commands forever ------------------------------------
cmdloop:
        jsr keypoll
        jsr rb_get
        cmp #OP_MODE
        beq op_mode
        bcs cmdloop
        asl
        tay
        iny
        lda (optab),y
        pha
        dey
        lda (optab),y
        pha
        rts

; MODE display: switch to it, and say so.
op_mode:
        jsr rb_get
        jsr set_screen
        jsr hello
        jmp cmdloop

; HELLO_ON, the display, and MODES: the bridge redraws everything.
hello:
        lda #MSG_HELLO_ON
        jsr send
        lda display
        jsr send
        lda #MSG_MODES
        jsr send
        lda #MODES_MASK
        jmp send

; Switch to display A, if there is a screen for it (C clear), else stay (C set). The
; game hardware and the SID start over, as on a fresh start.
set_screen:
        ldx #NUM_SCREENS - 1
:       cmp screen_ids,x
        beq @found
        dex
        bpl :-
        sec
        rts
@found: sta display
        stx screen
        php
        sei
        jsr game_reset
        jsr sound_init
        ldx screen
        lda screen_ops_lo,x
        sta optab
        lda screen_ops_hi,x
        sta optab+1
        lda screen_init_hi,x
        pha
        lda screen_init_lo,x
        pha
        rts                     ; to the screen's set-up, which returns to set_screen_done
set_screen_done:
        plp
        clc
        rts

display:        .byte $FF           ; its id
screen:         .byte 0             ; its index in the tables below

NUM_SCREENS = 4
screen_ids:     .byte DISPLAY_C64, DISPLAY_C64_HIRES, DISPLAY_C64_80, DISPLAY_C64_53
screen_ops_lo:  .byte <text::optable, <hires::optable, <s80::optable, <s53::optable
screen_ops_hi:  .byte >text::optable, >hires::optable, >s80::optable, >s53::optable
screen_init_lo: .byte <(init_text-1), <(init_hires-1), <(init_s80-1), <(init_s53-1)
screen_init_hi: .byte >(init_text-1), >(init_hires-1), >(init_s80-1), >(init_s53-1)

init_text:
        jsr text::init_charset
        jsr text::init_screen
        jmp set_screen_done
init_hires:
        jsr hires::init_font
        jsr hires::init_screen
        jmp set_screen_done
init_s80:
        jsr s80::init_tables
        jsr s80::init_screen
        jmp set_screen_done
init_s53:
        jsr s53::init_tables
        jsr s53::init_screen
        jmp set_screen_done

; The sprites off, as the KERNAL leaves them, and the game's glides and scripts stopped
; (its variables zeroed, but for the KERNAL's interrupt vector, which it chains to).
game_reset:
        lda #0
        sta VIC_IRQEN
        sta SPR_ON
        sta SPR_YEXP
        sta SPR_PRIO
        sta SPR_MULTI
        sta SPR_XEXP
        ldx #gold - GV
:       sta GV - 1,x
        dex
        bne :-
        lda VIC_IRQFLG
        sta VIC_IRQFLG
        rts

; The character ROM's lowercase half to ROMCHARS, once (the screens build their fonts
; from it whenever they come on). The ROM shows only with the I/O area switched out,
; so this is done before the NMI is the client's, and not again after a restart.
copy_rom_font:
        lda rom_copied
        bne @out
        lda #$32                ; character ROM visible at $D000, BASIC's ROM still out
        sta $01
        ldx #0
:       lda ROMFONT,x
        sta ROMCHARS,x
        lda ROMFONT+$100,x
        sta ROMCHARS+$100,x
        lda ROMFONT+$200,x
        sta ROMCHARS+$200,x
        lda ROMFONT+$300,x
        sta ROMCHARS+$300,x
        inx
        bne :-
        lda #$36
        sta $01
        inc rom_copied
@out:   rts

rom_copied:     .byte 0

; --- serial ------------------------------------------------------------------

; Next received byte in A, flags set from it; polls the keyboard while
; waiting. Clobbers Y.
rb_get:
        lda rp
        cmp wp
        bne @have
        lda rp+1
        cmp wp+1
        bne @have
        jsr keypoll
        jmp rb_get
@have:  ldy #0
        lda (rp),y
        sta tmp
        inc rp
        bne @out
        inc rp+1
        lda rp+1
        cmp #>RBUF_END
        bne @out
        lda #>RBUF
        sta rp+1
@out:   lda tmp
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

; The byte is stored before wp moves on, so rb_get never reads ahead of it.
nmi:
        pha
        tya
        pha
        lda ACIA_STATUS         ; also acknowledges the interrupt
        bpl @restore            ; bit 7: the ACIA's interrupt, else RESTORE
        and #$08                ; receive register full?
        beq @out
        lda ACIA_DATA
        ldy #0
        sta (wp),y
        inc wp
        bne @out
        inc wp+1
        lda wp+1
        cmp #>RBUF_END
        bne @out
        lda #>RBUF
        sta wp+1
@out:   pla
        tay
        pla
        rti
@restore:
        lda CURKEY
        cmp #STOP_KEY           ; RUN/STOP+RESTORE?
        bne @out
        jmp restart

init_acia:
        sta ACIA_STATUS         ; programmed reset
        lda #%00011111          ; 1 stop, 8 bits, internal clock, 19200 (38400 on SwiftLink)
        sta ACIA_CTRL
        lda #%00001001          ; no parity, RTS low, TX irq off, RX irq on, DTR on
        sta ACIA_CMD
        lda ACIA_DATA           ; discard anything pending
        rts

.include "dial.inc"
.include "restart.inc"

; The next byte the NMI has put in the receive ring: C set and A = it, else C clear. Clobbers X.
dial_rx:
        lda rp
        cmp wp
        bne @have
        lda rp+1
        cmp wp+1
        beq @none
@have:  ldx #0
        lda (rp,x)
        sta tmp
        inc rp
        bne @out
        inc rp+1
        lda rp+1
        cmp #>RBUF_END
        bne @out
        lda #>RBUF
        sta rp+1
@out:   lda tmp
        sec
        rts
@none:  clc
        rts

; --- keyboard ----------------------------------------------------------------

; Once per jiffy: send KEY for new presses and auto-repeats. Clobbers A.
keypoll:
        jsr game_poll
        lda JIFFY_LO
        cmp lastjiffy
        beq @out
        sta lastjiffy
        lda #0
        sta KEYCOUNT            ; we read the matrix, not the KERNAL buffer
        lda CURKEY
        cmp #64
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
        lda SHFLAG
        and #7
        jsr send
@out:   rts
@none:  sta lastkey
        rts

.macro RX_PENDING target
        lda rp
        cmp wp
        bne target
        lda rp+1
        cmp wp+1
        bne target
.endmacro
.include "sound.inc"
.include "game.inc"
.include "glyphs.inc"

; --- the screens -------------------------------------------------------------

.scope text
.include "main.s"
.endscope
.scope hires
.include "mainhires.s"
.endscope
.scope s80
.include "main80.s"
.endscope
.scope s53
.include "main53.s"
.endscope

; The dial's progress, and asking for its settings (dialask.inc), are on the text screen.
UI_COLS     = 40
CFG         = $0334             ; the cassette buffer
.if DIAL_DBGCODE
ui_cell     = text::ui_cell
ui_clear    = text::ui_clear
.endif
init_screen = text::init_screen
.include "dialask.inc"
