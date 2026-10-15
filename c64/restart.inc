; --- RUN/STOP+RESTORE ---------------------------------------------------------
;
; The client's NMI jumps here for RESTORE with RUN/STOP held (an NMI the ACIA did not
; raise). Starts the client again as if it had just been run: the screen, the SID, the
; sprites and the interrupts go back as the KERNAL leaves them, and the client says
; hello to the bridge anew, after dialling again if it was built to dial (dial hangs up first).
; Shared by all the clients: needs start, sound_timers_off and dial_restarted.

restart:
        ldx #$FF                ; out of the NMI for good
        txs
        cld
        lda #0
        sta $D01A               ; no raster interrupt (game.inc's)
        sta $D015               ; no sprites
        lda $D019
        sta $D019               ; and none pending
        jsr sound_timers_off
        jsr $FF8A               ; RESTOR: the KERNAL's vectors, or game_init would chain to its own
        lda #1
        sta dial_restarted
        jmp start
