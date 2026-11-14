// Memory card layout and the "delete oldest when full" rule.
//
//   /rec/000042/ID           recording id, for example "D1234-1"
//   /rec/000042/000000.hcv   finished chunks, 10 seconds each
//   /rec/000042/000003.tmp   the chunk being written right now
//   /rec/000042/END          "<chunk count>,<0 or 1 if interrupted>", written when recording stops
//   /purged.txt              ids of recordings deleted before they could be uploaded
//
// Recordings stay on the card after upload as a local backup. They are only
// deleted, oldest first, when free space runs low.
#pragma once

#include <Arduino.h>

namespace Storage {

bool begin();

String recordingDir(uint32_t seq);
String chunkPath(uint32_t seq, uint32_t idx);
String tempChunkPath(uint32_t seq, uint32_t idx);

String readText(const String& path);
bool writeText(const String& path, const String& text);

bool createRecording(uint32_t seq, const char* recordingId);
uint32_t freeMB();

// Deletes the oldest recordings until MIN_FREE_MB is free. Never touches
// recordings numbered `protectFromSeq` or higher. Skips quietly if the
// uploader is busy; it will be called again at the next chunk.
void ensureSpace(uint32_t protectFromSeq);

// If power was lost mid recording, closes that recording so it can be uploaded.
void recoverInterrupted();

// Serialises changes to the upload position and the purge list.
bool lock(uint32_t waitMs);
void unlock();

// Purge list helpers. Call with the lock held.
String takePurgedList();
void savePurgedList(const String& lines);

}  // namespace Storage
