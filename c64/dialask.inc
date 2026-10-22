; --- the dial's progress, and asking for its settings (all five clients) --------------
;
; Included by each client after dial.inc, which says when each part is built:
;
;   DIAL_DBGCODE   DIALDEBUG=1, or DIALASK=1: the dial's progress at the bottom of the screen (rows 21-24).
;   DIAL_ASKING    DIALASK=1: the modem's start-up command (DIALINIT), the bridge's address (DIAL) and whether to
;                  show the progress live in PETTY.CFG on the drive the program came from (the KERNAL's last device,
;                  8 if that is not a disk). At start the file is loaded; if there is none, the screen asks, with the
;                  built-in DIAL, DIALINIT and DIALDEBUG as what is shown, and saves the answers. If the call does not
;                  come in 9-13 seconds the screen asks again, with the current values shown.
;
; Everything is drawn one character at a time through the client's own routine, so one engine serves the text,
; 80-column VDC, soft 80- and 53-column and hi-res clients. A client provides:
;
;   UI_COLS      its width (40, 53 or 80); the height is 25
;   CFG          where the settings live (RAM the KERNAL's tape code would use): 71 bytes
;   ui_cell      A = screen code, X = column, Y = row: draw it there. May clobber anything but the stack.
;   ui_clear     clear the screen
;   init_screen  draw the "waiting for bridge" banner (also clears)
;   CLIENT_C128  (the C128 client only) KERNAL calls need SETBNK, and its 2 MHz mode is dropped for the disk
;
; Keys come from the KERNAL's GETIN: its interrupt still scans the keyboard in every client. Characters in this
; file's strings are screen codes for the lowercase set (a-z at 1, A-Z at 65).
; The settings: debug flag ($80 = show), command + 0 (30 characters), host + 0 (38).

.if DIAL_DBGCODE

; A screen code to the progress area, rows 21-24, until it is full. Keeps A, X, Y.
dbg_put:
.if DIAL_ASKING
        bit cfg_dbg             ; asked for?
        bmi :+
        rts
:
.endif
        sta dbg_a
        txa
        pha
        tya
        pha
        lda dbg_row
        cmp #4
        bcs @out                ; full: keep what is there
        clc
        adc #20
        tay
        ldx dbg_col
        lda dbg_a
        jsr ui_cell
        inc dbg_col
        lda dbg_col
        cmp #UI_COLS
        bcc @out
        lda #0
        sta dbg_col
        inc dbg_row
@out:   pla
        tay
        pla
        tax
        lda dbg_a
        rts

; ASCII in A -> screen codes in the progress area, a byte that is not text as $ and its hex. Keeps A, X, Y.
dbg_rx:
        pha
        cmp #13
        bne :+
        lda #'/'
        bne @put
:       cmp #97
        bcc :+
        cmp #123
        bcs :+
        sbc #95                 ; carry clear: A - 96, lowercase -> 1-26
        bne @put
:       cmp #32
        bcc @hex
        cmp #96
        bcc @put
@hex:   lda #'$'
        jsr dbg_put
        pla
        pha
        jsr dbg_hex
        pla
        rts
@put:   jsr dbg_put
        pla
        rts

; A in hex ('A'-'F' show as lowercase).
dbg_hex:
        pha
        lsr
        lsr
        lsr
        lsr
        jsr @nib
        pla
        and #$0F
@nib:   cmp #10
        bcc :+
        sbc #9                  ; 10-15 -> screen codes 1-6
        bne @out
:       adc #'0'
@out:   jmp dbg_put

dbg_row: .byte 0
dbg_col: .byte 0
dbg_a:   .byte 0
.endif

.if DIAL_ASKING

GETIN       = $FFE4
SETNAM      = $FFBD
SETLFS      = $FFBA
SETBNK      = $FF68             ; C128 only
LOAD        = $FFD5
SAVE        = $FFD8
MSGFLG      = $9D               ; bit 7: the KERNAL prints SEARCHING, LOADING, SAVING
FA          = $BA               ; the last device used

cfg_dbg     = CFG
cfg_init    = CFG + 1
cfg_host    = CFG + 1 + 31
INIT_MAX    = 30
HOST_MAX    = 38
CFG_SIZE    = 1 + 31 + 39

NL          = $FF               ; new line in a string (13 is the letter m)
CURSOR      = 31                ; screen code of the underscore

ed_ptr      = src               ; the string being edited
ed_len      = count             ; its length
ed_max      = top               ; the most it may be
ed_fresh    = bot               ; nonzero until a key is typed: a letter replaces the string
ed_dst      = dst               ; puts' pointer

; File names are ASCII: the drive wants capitals at $41.
name_load:  .byte "PETTY.CFG"
name_load_end:
name_save:  .byte "@0:PETTY.CFG"
name_save_end:

; The strings below are screen codes: a-z at 1.
.repeat 26, i
.charmap $61 + i, 1 + i
.endrep

; Called by dial with interrupts on: the settings, from disk or by asking.
cfg_start:
        jsr cfg_defaults
        jsr cfg_load
        bcc @out
        jsr cfg_defaults        ; a file of the wrong size may have overwritten some
        lda #1
        sta cfg_dirty
        lda #<msg_title
        ldx #>msg_title
        jsr cfg_ask
@out:   rts

; The call did not come in: ask again, then save if anything changed.
cfg_failed:
        lda #<msg_failed
        ldx #>msg_failed
        ; fall through

; A/X: the heading. Asks all three, saves if anything changed, and puts the banner back.
cfg_ask:
        sta cfg_head
        stx cfg_head + 1
        jsr ui_clear
        lda #0
        sta ui_row
        sta ui_col
        lda cfg_head
        ldx cfg_head + 1
        jsr puts
        lda #<msg_init
        ldx #>msg_init
        jsr puts
        lda #<cfg_init
        sta ed_ptr
        lda #>cfg_init
        sta ed_ptr+1
        lda #INIT_MAX
        sta ed_max
        jsr show_edit
        lda #<msg_host
        ldx #>msg_host
        jsr puts
        lda #<cfg_host
        sta ed_ptr
        lda #>cfg_host
        sta ed_ptr+1
        lda #HOST_MAX
        sta ed_max
        jsr show_edit
        lda #<msg_dbg
        ldx #>msg_dbg
        jsr puts
        jsr ask_dbg
        lda #NL
        jsr ui_putc
        lda cfg_dirty
        beq @done
        jsr cfg_save
@done:  lda #0
        sta dbg_row             ; the progress lines start again
        sta dbg_col
        jmp init_screen         ; the banner again

; Print the string being edited and edit it; RETURN ends the line.
show_edit:
        ldy #0
:       lda (ed_ptr),y
        beq :+
        sty ui_y
        jsr ui_putc
        ldy ui_y
        iny
        bne :-
:       jsr edit_line
        lda #NL
        jmp ui_putc

; Y/N for cfg_dbg, with the current answer shown. RETURN keeps it.
ask_dbg:
        lda cfg_dbg
        jsr show_yn
@key:   jsr GETIN
        and #$7F                ; shifted or not
        cmp #$59
        beq @yes
        cmp #$4E
        beq @no
        cmp #13
        bne @key
        rts
@yes:   lda #$80
        .byte $2C               ; bit: skip the next lda
@no:    lda #0
        cmp cfg_dbg
        beq :+
        sta cfg_dbg
        inc cfg_dirty
:       ; fall through

; A: $80 shows "yes", else "no"; the cursor goes back over it.
show_yn:
        bpl @no
        lda #<msg_yes
        ldx #>msg_yes
        bne @show
@no:    lda #<msg_no
        ldx #>msg_no
@show:  jsr puts
        lda ui_col
        sec
        sbc #3
        sta ui_col
        rts

; Edit the 0-terminated ASCII string at (ed_ptr), at most ed_max characters, which the screen already shows with the
; cursor at its end. A letter or digit typed first replaces it; DEL edits. Returns on RETURN.
edit_line:
        ldy #0
:       lda (ed_ptr),y
        beq :+
        iny
        bne :-
:       sty ed_len
        lda #1
        sta ed_fresh
@top:   lda #CURSOR
        jsr ui_mark
@poll:  jsr GETIN
        beq @poll
        pha
        lda #32                 ; the cursor off
        jsr ui_mark
        pla
        cmp #13
        beq @done
        cmp #$14                ; DEL
        beq @del
        cmp #$C1                ; shifted letters
        bcc :+
        cmp #$DB
        bcs :+
        and #$7F
:       cmp #32
        bcc @top
        cmp #$5B
        bcs @top
        cmp #34                 ; no quotes: they are not for a host or a command
        beq @top
        pha
        lda ed_fresh
        beq :+
        jsr ed_wipe
:       lda #0
        sta ed_fresh
        inc cfg_dirty
        lda ed_len
        cmp ed_max
        bcs @full
        tay
        pla
        sta (ed_ptr),y
        pha
        iny
        lda #0
        sta (ed_ptr),y
        sty ed_len
        pla
        jsr ui_putc             ; ASCII $20-$5A is its own screen code
        jmp @top
@full:  pla
        jmp @top
@del:   lda #0
        sta ed_fresh
        lda ed_len
        beq @top
        dec ed_len
        ldy ed_len
        lda #0
        sta (ed_ptr),y
        inc cfg_dirty
        jsr ui_back
        jmp @top
@done:  rts

; Delete what is shown and empty the string.
ed_wipe:
        lda ed_len
        beq @out
        jsr ui_back
        dec ed_len
        jmp ed_wipe
@out:   ldy #0
        tya
        sta (ed_ptr),y
        rts

; --- the screen: a cursor over ui_cell ----------------------------------------

; A to the cell under the cursor, which stays.
ui_mark:
        ldx ui_col
        ldy ui_row
        jmp ui_cell

; Screen code A (NL: new line) at the cursor, which moves on.
ui_putc:
        cmp #NL
        beq ui_nl
        ldx ui_col
        ldy ui_row
        jsr ui_cell
        inc ui_col
        lda ui_col
        cmp #UI_COLS
        bcc ui_end
ui_nl:  lda #0
        sta ui_col
        lda ui_row
        cmp #24
        bcs ui_end
        inc ui_row
ui_end: rts

; One character back, blank.
ui_back:
        lda ui_col
        bne @col
        lda ui_row
        beq @out
        dec ui_row
        lda #UI_COLS
@col:   sec
        sbc #1
        sta ui_col
        lda #32
        jmp ui_mark
@out:   rts

; A/X: a 0-terminated string, to the screen.
puts:
        sta ed_dst
        stx ed_dst+1
        ldy #0
:       lda (ed_dst),y
        beq @out
        sty ui_y
        jsr ui_putc
        ldy ui_y
        iny
        bne :-
@out:   rts

; --- the file -----------------------------------------------------------------

; The built-in values, as what is shown first.
cfg_defaults:
        ldx #0
:       lda dial_init_def,x
        sta cfg_init,x
        beq :+
        inx
        cpx #INIT_MAX
        bne :-
        lda #0
        sta cfg_init,x
:       ldx #0
:       lda dial_host_def,x
        sta cfg_host,x
        beq :+
        inx
        cpx #HOST_MAX
        bne :-
        lda #0
        sta cfg_host,x
:       lda #0
        sta cfg_dirty
.if DIAL_DEBUG
        lda #$80
        sta cfg_dbg
.else
        lda #0
        sta cfg_dbg
.endif
        rts

; Drive for the file: the last device used, or 8. No KERNAL messages. The C128 also wants the banks
; of the data and of the name (RAM 0), and its 2 MHz mode off for the serial bus.
cfg_device:
        lda #0
        sta MSGFLG
.ifdef CLIENT_C128
        tax
        jsr SETBNK
        lda SPEED
        and #1                  ; the other bits read as 1, and bit 1 is a test bit
        sta cfg_speed
        lda #0
        sta SPEED
.endif
        lda FA
        cmp #8
        bcc @eight
        cmp #12
        bcc @ok
@eight: lda #8
@ok:    sta cfg_dev
        rts

cfg_fast:
.ifdef CLIENT_C128
        lda cfg_speed
        sta SPEED
.endif
        rts

; Carry clear: PETTY.CFG loaded.
cfg_load:
        jsr cfg_device
        lda #name_load_end - name_load
        ldx #<name_load
        ldy #>name_load
        jsr SETNAM
        lda #1
        ldx cfg_dev
        ldy #0                  ; load where X/Y say, not where the file says
        jsr SETLFS
        lda #0
        ldx #<CFG
        ldy #>CFG
        jsr LOAD
        bcs @bad
        cpx #<(CFG + CFG_SIZE)
        bne @bad
        cpy #>(CFG + CFG_SIZE)
        bne @bad
        lda #0                  ; whatever the file said, the strings end
        sta cfg_init + INIT_MAX
        sta cfg_host + HOST_MAX
        jsr cfg_fast
        clc
        rts
@bad:   jsr cfg_fast
        sec
        rts

cfg_save:
        jsr cfg_device
        lda #name_save_end - name_save
        ldx #<name_save
        ldy #>name_save
        jsr SETNAM
        lda #1
        ldx cfg_dev
        ldy #1
        jsr SETLFS
        lda #<CFG
        sta ed_ptr
        lda #>CFG
        sta ed_ptr+1
        lda #ed_ptr
        ldx #<(CFG + CFG_SIZE)
        ldy #>(CFG + CFG_SIZE)
        jsr SAVE
        php
        jsr cfg_fast
        plp
        bcc @out
        lda #NL                 ; say so, and give time to read it
        jsr ui_putc
        lda #<msg_nosave
        ldx #>msg_nosave
        jsr puts
        lda JIFFY_LO
        clc
        adc #150
        sta cfg_until
:       lda JIFFY_LO
        cmp cfg_until
        bne :-
@out:   lda #0
        sta cfg_dirty
        rts

cfg_dev:    .byte 8
cfg_dirty:  .byte 0
cfg_until:  .byte 0
cfg_speed:  .byte 0
cfg_head:   .word 0
ui_row:     .byte 0
ui_col:     .byte 0
ui_y:       .byte 0

msg_title:  .byte "PETTY modem setup", NL, NL
            .byte "RETURN keeps what is shown. Type to", NL
            .byte "replace it; DEL edits it.", NL, 0
msg_failed: .byte "Could not connect to the bridge.", NL
            .byte "Check the settings: RETURN keeps", NL
            .byte "what is shown.", NL, 0
msg_init:   .byte NL, "Modem start-up command (blank for", NL
            .byte "none; a TeensyROM wants ATC):", NL, 0
msg_host:   .byte NL, "Bridge to dial, as host:port:", NL, 0
msg_dbg:    .byte NL, "Show the dial's progress? (Y/N) ", 0
msg_yes:    .byte "yes", 0
msg_no:     .byte "no ", 0
msg_nosave: .byte "Could not save PETTY.CFG.", 0

.repeat 26, i
.charmap $61 + i, $61 + i
.endrep

.endif
