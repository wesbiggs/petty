; --- waiting for the bridge's WELCOME (both clients) ---------------------------
;
; At start (and after RUN/STOP+RESTORE) a client says hello and throws away everything it receives until the bridge's
; answer, WELCOME ($FF "PTY"), saying hello again every 3 seconds until it comes. Before this, whatever reached the
; client first was run as commands: a modem's echo of the hello when nothing had dialled, the modem's messages, or
; the frames a serial bridge sent before it had heard from the client. The bridge answers every hello, but each
; byte of WELCOME is above every opcode, so the command loop skips the later ones.
;
; Needs from the client: say_hello, rb_get (may clobber X and Y), RX_PENDING, JIFFY_LO (the KERNAL's interrupt
; must be running).

WELCOME_EVERY = 180             ; jiffies between hellos

hello_wait:
        jsr say_hello
        lda JIFFY_LO
        sta welcome_since
        lda #0
        sta welcome_n           ; bytes of WELCOME seen so far
@poll:  RX_PENDING @byte
        lda JIFFY_LO
        sec
        sbc welcome_since
        cmp #WELCOME_EVERY
        bcc @poll
        bcs hello_wait          ; no answer: hello again
@byte:  jsr rb_get
        ldx welcome_n
        cmp welcome,x
        beq @match
        ldx #0                  ; not the next byte: perhaps the first
        cmp welcome
        bne @set
@match: inx
        cpx #4
        beq @done
@set:   stx welcome_n
        jmp @poll
@done:  rts

welcome:        .byte $FF, $50, $54, $59        ; $FF "PTY" (protocol.js WELCOME)
welcome_since:  .byte 0
welcome_n:      .byte 0
