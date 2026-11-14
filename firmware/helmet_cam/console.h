// Text in and out over the USB serial port, at 115200 baud.
//
// This uses the ESP32's built in console instead of Arduino's Serial object,
// and that is deliberate. Serial installs a UART driver whose ring buffer code
// takes about 4 KB of IRAM. On this board, with Wi-Fi, Bluetooth and the
// camera all in one sketch, IRAM is full and those 4 KB make the sketch fail
// to link ("section .iram0.text will not fit in region iram0_0_seg").
//
// So: do not call Serial.begin() or use Serial anywhere in this sketch.
// The Serial Monitor works exactly as before.
#pragma once

#include <stdarg.h>
#include <stdio.h>
#include <unistd.h>

namespace Console {

// Sends each message straight away instead of waiting for a full buffer.
inline void begin() { setvbuf(stdout, nullptr, _IONBF, 0); }

inline void printf(const char* format, ...) __attribute__((format(printf, 1, 2)));
inline void printf(const char* format, ...) {
  va_list args;
  va_start(args, format);
  vprintf(format, args);
  va_end(args);
}

// Prints the text followed by a new line.
inline void println(const char* text) { puts(text); }

// The next character typed into the Serial Monitor, or -1 when there is none.
// Never waits.
inline int read() {
  char c;
  return ::read(STDIN_FILENO, &c, 1) == 1 ? (unsigned char)c : -1;
}

}  // namespace Console
