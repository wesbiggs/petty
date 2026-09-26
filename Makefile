BUILD   := build
PRG     := $(BUILD)/petty.prg
PORT    ?= 6464

# VICE: SwiftLink cartridge (6551 at $DE00, NMI) on RS-232 device 1, which
# is a raw TCP connection to the bridge.
VICE_FLAGS := -acia1 -acia1mode 1 -acia1base 0xDE00 -acia1irq 1 \
              -myaciadev 0 -rsdev1 127.0.0.1:$(PORT) +rsdev1ip232 -rsdev1baud 38400

.PHONY: all clean bridge vice run test

all: $(PRG)

c64/glyphs.inc: bridge/src/glyphs.js bridge/scripts/gen-glyphs.js
	node bridge/scripts/gen-glyphs.js

$(BUILD)/main.o: c64/main.s c64/glyphs.inc | $(BUILD)
	ca65 -I c64 -l $(BUILD)/main.lst -o $@ c64/main.s

$(PRG): $(BUILD)/main.o c64/petty.cfg
	ld65 -C c64/petty.cfg -m $(BUILD)/petty.map -o $@ $(BUILD)/main.o

$(BUILD):
	mkdir -p $@

bridge/node_modules:
	cd bridge && npm install && chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper

# Terminal 1: the bridge (extra args: make bridge CMD="bash")
bridge: bridge/node_modules
	node bridge/src/bridge.js --port $(PORT) $(CMD)

# Terminal 2: the emulator
vice: $(PRG)
	x64sc $(VICE_FLAGS) -autostart $(PRG)

test: bridge/node_modules
	cd bridge && node --test

clean:
	rm -rf $(BUILD)
