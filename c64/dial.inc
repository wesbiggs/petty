; --- dialling a WiFi modem ----------------------------------------------------
;
; Built with `make DIAL=host:port`, a client dials the bridge through a
; Hayes-style modem (ATDT host:port) before it says hello, and waits for
; CONNECT, dialling again every half minute until one comes. Built without,
; dial does nothing. Shared by all the clients: needs ACIA_*, JIFFY_LO and
; send.

.include "dialstr.inc"          ; dial_host: the DIAL string, 0-terminated

JIFFY_MID   = $A1               ; jiffy clock, middle byte: +1 every 4.3 s
DIAL_WAIT   = 7                 ; ...so about 30 s for CONNECT
DIAL_SETTLE = 60                ; jiffies of quiet before dialling
DIAL_QUIET  = 30                ; jiffies of quiet that end CONNECT's line

; Polls the ACIA with its receive interrupt off, so call it after init_acia,
; with interrupts on for the jiffy clock. Clobbers A, X, Y.
dial:
        lda dial_host
        bne :+
        rts
:       lda #%00001011          ; as init_acia, but RX irq off
        sta ACIA_CMD
@redial:
        lda #13                 ; end a dial still in progress, or a stray line
        jsr send
        lda #DIAL_SETTLE
        jsr dial_drain
        ldx #0
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
        beq @redial
        lda ACIA_STATUS
        and #$08                ; receive register full?
        beq @wait
        lda ACIA_DATA
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
        lda #DIAL_QUIET
        jsr dial_drain
        lda #%00001001          ; RX irq back on
        sta ACIA_CMD
        rts

; Discard received bytes until none has come for A jiffies.
dial_drain:
        sta dial_quiet
@quiet: lda JIFFY_LO
        sta dial_since
@poll:  lda ACIA_STATUS
        and #$08
        beq :+
        lda ACIA_DATA
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
