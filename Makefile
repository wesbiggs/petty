BUILD   := build
PRG     := $(BUILD)/petty.prg
PRG128  := $(BUILD)/petty128.prg
PRG80   := $(BUILD)/petty80.prg
PRGHI   := $(BUILD)/pettyhires.prg
PORT    ?= 6464

# VICE: SwiftLink cartridge (6551 at $DE00, NMI) on RS-232 device 1, which
# is a raw TCP connection to the bridge.
VICE_FLAGS := -acia1 -acia1mode 1 -acia1base 0xDE00 -acia1irq 1 \
              -myaciadev 0 -rsdev1 127.0.0.1:$(PORT) +rsdev1ip232 -rsdev1baud 38400

.PHONY: all clean bridge vice vice128 vice80 vicehires run test

all: $(PRG) $(PRG128) $(PRG80) $(PRGHI)

# The generator writes both includes.
c64/glyphs.inc: bridge/src/glyphs.js bridge/src/font4x8.js bridge/scripts/gen-glyphs.js
	node bridge/scripts/gen-glyphs.js
c64/font4x8.inc: c64/glyphs.inc ;

$(BUILD)/main.o: c64/main.s c64/glyphs.inc | $(BUILD)
	ca65 -I c64 -l $(BUILD)/main.lst -o $@ c64/main.s

$(PRG): $(BUILD)/main.o c64/petty.cfg
	ld65 -C c64/petty.cfg -m $(BUILD)/petty.map -o $@ $(BUILD)/main.o

$(BUILD)/main128.o: c128/main.s c64/glyphs.inc | $(BUILD)
	ca65 -I c64 -l $(BUILD)/main128.lst -o $@ c128/main.s

$(PRG128): $(BUILD)/main128.o c128/petty128.cfg
	ld65 -C c128/petty128.cfg -m $(BUILD)/petty128.map -o $@ $(BUILD)/main128.o

$(BUILD)/main80.o: c64/main80.s c64/font4x8.inc | $(BUILD)
	ca65 -I c64 -l $(BUILD)/main80.lst -o $@ c64/main80.s

$(PRG80): $(BUILD)/main80.o c64/petty80.cfg
	ld65 -C c64/petty80.cfg -m $(BUILD)/petty80.map -o $@ $(BUILD)/main80.o

$(BUILD)/mainhires.o: c64/mainhires.s c64/glyphs.inc | $(BUILD)
	ca65 -I c64 -l $(BUILD)/mainhires.lst -o $@ c64/mainhires.s

$(PRGHI): $(BUILD)/mainhires.o c64/pettyhires.cfg
	ld65 -C c64/pettyhires.cfg -m $(BUILD)/pettyhires.map -o $@ $(BUILD)/mainhires.o

$(BUILD):
	mkdir -p $@

bridge/node_modules:
	cd bridge && npm install

# Terminal 1: the bridge (extra args: make bridge CMD="bash")
bridge: bridge/node_modules
	node bridge/src/bridge.js --port $(PORT) $(CMD)

# Terminal 2: the emulator
vice: $(PRG)
	x64sc $(VICE_FLAGS) -autostart $(PRG)

# Terminal 2, C128 in 80 columns (the VDC window)
vice128: $(PRG128)
	x128 -80col $(VICE_FLAGS) -autostart $(PRG128)

# Terminal 2, C64 with the soft 80-column bitmap screen
vice80: $(PRG80)
	x64sc $(VICE_FLAGS) -autostart $(PRG80)

# Terminal 2, C64 with the 40-column hi-res bitmap screen
vicehires: $(PRGHI)
	x64sc $(VICE_FLAGS) -autostart $(PRGHI)

test: bridge/node_modules
	cd bridge && node --test

clean:
	rm -rf $(BUILD)
