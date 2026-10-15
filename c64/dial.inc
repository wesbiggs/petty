; --- dialling a WiFi modem ----------------------------------------------------
;
; Built with `make DIAL=host:port`, a client dials the bridge through a
; Hayes-style modem (ATDT host:port, after DIALINIT's line if given) before it says hello, and waits for
; CONNECT, dialling again every half minute until one comes. Built without,
; dial does nothing. Shared by all the clients: needs ACIA_*, JIFFY_LO and
; send.

.include "dialstr.inc"          ; dial_host_def, dial_init_def: DIAL and DIALINIT, 0-terminated

; A client that can ask (c64/main.s defines CLIENT_ASK, includes dialask.inc) and was built with DIALASK=1 keeps the
; values in a buffer it edits (cfg_host, cfg_init, cfg_dbg), loads them from PETTY.CFG, and asks when there is none
; or the call does not come. The others dial the built-in values, if any.
DIAL_ASKING = DIAL_ASK && .defined(CLIENT_ASK)
DIAL_DBGCODE = DIAL_DEBUG || DIAL_ASKING
.if DIAL_ASKING
dial_host = cfg_host
dial_init = cfg_init
.else
dial_host = dial_host_def
dial_init = dial_init_def
.endif

; DIALDEBUG=1 (c64 and c128 only): progress on the screen (c64: lines 21-24, c128: lines 3-5): the ACIA status in hex, then ">I" init sent, ">T" ATDT sent,
; ">D" a redial, ">C" CONNECT seen, ">X" done, and what the modem sends (a byte that is not text as $ and its hex). The area fills once and then holds.
.macro DBGM ch
.if DIAL_DBGCODE
        pha
        lda #'>'
        jsr dbg_put
        lda #ch
        jsr dbg_put
        pla
.endif
.endmacro
.macro DBGRX
.if DIAL_DBGCODE
        jsr dbg_rx
.endif
.endmacro

JIFFY_MID   = $A1               ; jiffy clock, middle byte: +1 every 4.3 s
.if DIAL_ASKING
DIAL_WAIT   = 3                 ; ...so 9-13 s for CONNECT, then ask again
.else
DIAL_WAIT   = 7                 ; ...so about 30 s for CONNECT
.endif
DIAL_SETTLE = 60                ; jiffies of quiet before dialling
DIAL_INIT_QUIET = 180           ; jiffies of quiet that end DIALINIT's answer (an Ethernet modem takes a while)
DIAL_QUIET  = 30                ; jiffies of quiet that end CONNECT's line

; Reads what the modem says from the client's receive ring (its NMI fills it: dial_rx, one
; per client), so call it after init_acia, with interrupts on for the jiffy clock. Clobbers A, X, Y.
dial:
.if !DIAL_ASKING
        lda dial_host
        bne :+
        rts
:
.endif
.if DIAL_ASKING
        lda #%00001011          ; the disk is slow to talk to if the modem interrupts: RX irq off for cfg_start
        sta ACIA_CMD
        jsr cfg_start
.endif
        lda #%00001001          ; RX irq on: the client's NMI fills its ring and dial_rx reads it
        sta ACIA_CMD
@redial:
.if DIAL_ASKING
        lda dial_host           ; blank: nothing to dial
        bne :+
        rts
:
.endif
        DBGM 'D'
.if DIAL_DBGCODE
        pha
        lda ACIA_STATUS
        jsr dbg_hex
        pla
.endif
        lda #13                 ; end a dial still in progress, or a stray line
        jsr send
        lda #DIAL_SETTLE
        jsr dial_drain
        lda dial_init           ; DIALINIT: a command line to send first
        beq @dial
        ldx #0
:       lda dial_init,x
        beq :+
        jsr send
        inx
        bne :-
:       lda #13
        jsr send
        lda #DIAL_INIT_QUIET
        jsr dial_drain
        DBGM 'I'
@dial:  ldx #0
:       lda dial_cmd,x
        beq :+
        jsr send
        inx
        bne :-
:       ldx #0
:       lda dial_host,x
        beq :+
        jsr send
        inx
        bne :-
:       lda #13
        jsr send
        lda JIFFY_MID
        clc
        adc #DIAL_WAIT
        sta dial_until
        ldy #0                  ; characters of CONNECT matched so far
@wait:  lda JIFFY_MID
        cmp dial_until
.if DIAL_ASKING
        bne :+
        lda #%00001011
        sta ACIA_CMD
        jsr cfg_failed
        lda #%00001001
        sta ACIA_CMD
        jmp @redial
:
.else
        beq @redial
.endif
        jsr dial_rx             ; C = a byte, in A (clobbers X)
        bcc @wait
        DBGRX
        cmp dial_connect,y
        beq @match
        ldy #0
        cmp dial_connect
        bne @wait
@match: iny
        cpy #7
        bne @wait
        ; The rest of the result line, and the frame the bridge sent when the
        ; call came in, go; the bridge redraws everything after our hello.
        DBGM 'C'
        lda #DIAL_QUIET
        jsr dial_drain
        DBGM 'X'
        rts

; Discard received bytes until none has come for A jiffies.
dial_drain:
        sta dial_quiet
@quiet: lda JIFFY_LO
        sta dial_since
@poll:  jsr dial_rx
        bcc :+
        DBGRX
        jmp @quiet
:       lda JIFFY_LO
        sec
        sbc dial_since
        cmp dial_quiet
        bcc @poll
        rts

dial_cmd:     .byte "ATDT", 0
dial_connect: .byte "CONNECT"
dial_until:   .byte 0
dial_since:   .byte 0
dial_quiet:   .byte 0
