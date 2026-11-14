#include "storage.h"

#include <SD_MMC.h>

#include "config.h"
#include "console.h"
#include "settings.h"

namespace {

SemaphoreHandle_t mutex = nullptr;
const char* PURGED_FILE = "/purged.txt";

String numbered(uint32_t value) {
  char text[8];
  snprintf(text, sizeof(text), "%06lu", (unsigned long)value);
  return String(text);
}

uint32_t countChunks(uint32_t seq) {
  uint32_t count = 0;
  while (SD_MMC.exists(Storage::chunkPath(seq, count))) count++;
  return count;
}

// File names are predictable, so no directory listing is needed.
void removeRecording(uint32_t seq) {
  const String dir = Storage::recordingDir(seq);
  if (!SD_MMC.exists(dir)) return;
  for (uint32_t idx = 0;; idx++) {
    const String chunk = Storage::chunkPath(seq, idx);
    const String temp = Storage::tempChunkPath(seq, idx);
    const bool hadChunk = SD_MMC.exists(chunk);
    const bool hadTemp = SD_MMC.exists(temp);
    if (hadChunk) SD_MMC.remove(chunk);
    if (hadTemp) SD_MMC.remove(temp);
    if (!hadChunk && !hadTemp) break;
  }
  SD_MMC.remove(dir + "/ID");
  SD_MMC.remove(dir + "/END");
  SD_MMC.rmdir(dir);
}

}  // namespace

namespace Storage {

bool begin() {
  mutex = xSemaphoreCreateMutex();
  // 1 bit mode is slower than 4 bit but leaves GPIO 4 (the flash LED) alone.
  if (!SD_MMC.begin("/sdcard", true)) return false;
  if (SD_MMC.cardType() == CARD_NONE) return false;
  if (!SD_MMC.exists("/rec")) SD_MMC.mkdir("/rec");
  return true;
}

String recordingDir(uint32_t seq) { return "/rec/" + numbered(seq); }
String chunkPath(uint32_t seq, uint32_t idx) { return recordingDir(seq) + "/" + numbered(idx) + ".hcv"; }
String tempChunkPath(uint32_t seq, uint32_t idx) { return recordingDir(seq) + "/" + numbered(idx) + ".tmp"; }

String readText(const String& path) {
  File file = SD_MMC.open(path, FILE_READ);
  if (!file) return "";
  String text = file.readString();
  file.close();
  text.trim();
  return text;
}

bool writeText(const String& path, const String& text) {
  File file = SD_MMC.open(path, FILE_WRITE);
  if (!file) return false;
  const bool ok = file.print(text) == text.length();
  file.close();
  return ok;
}

bool createRecording(uint32_t seq, const char* recordingId) {
  const String dir = recordingDir(seq);
  removeRecording(seq);  // clear leftovers if the card was reused
  if (!SD_MMC.mkdir(dir)) return false;
  return writeText(dir + "/ID", recordingId);
}

uint32_t freeMB() {
  return (uint32_t)((SD_MMC.totalBytes() - SD_MMC.usedBytes()) / (1024ULL * 1024ULL));
}

void ensureSpace(uint32_t protectFromSeq) {
  if (freeMB() >= MIN_FREE_MB) return;
  if (!lock(0)) return;  // uploader is mid transfer; try again at the next chunk

  while (freeMB() < MIN_FREE_MB) {
    const uint32_t oldest = Settings::oldestSeq();
    if (oldest >= protectFromSeq) break;  // nothing older left to delete

    if (oldest >= Settings::uploadSeq()) {
      // This recording never finished uploading. Remember its id so the server
      // can be told the evidence is gone, then move the uploader past it.
      const String id = readText(recordingDir(oldest) + "/ID");
      if (id.length()) {
        File list = SD_MMC.open(PURGED_FILE, FILE_APPEND);
        if (list) {
          list.println(id);
          list.close();
        }
      }
      Settings::setUploadPosition(oldest + 1, 0);
    }
    Console::printf("[storage] card nearly full, deleting recording %lu\n", (unsigned long)oldest);
    removeRecording(oldest);
    Settings::setOldestSeq(oldest + 1);
  }
  unlock();
}

void recoverInterrupted() {
  const uint32_t next = Settings::nextSeq();
  if (next == 0) return;
  const uint32_t seq = next - 1;
  const String dir = recordingDir(seq);
  if (!SD_MMC.exists(dir) || SD_MMC.exists(dir + "/END")) return;

  uint32_t chunks = countChunks(seq);
  const String temp = tempChunkPath(seq, chunks);
  if (SD_MMC.exists(temp)) {
    // The half written chunk is still useful: the server reads frames up to the break.
    SD_MMC.rename(temp, chunkPath(seq, chunks));
    chunks++;
  }
  writeText(dir + "/END", String(chunks) + ",1");
  Console::printf("[storage] recovered interrupted recording %lu with %lu chunks\n",
                (unsigned long)seq, (unsigned long)chunks);
}

bool lock(uint32_t waitMs) { return xSemaphoreTake(mutex, pdMS_TO_TICKS(waitMs)) == pdTRUE; }
void unlock() { xSemaphoreGive(mutex); }

String takePurgedList() {
  File file = SD_MMC.open(PURGED_FILE, FILE_READ);
  if (!file) return "";
  String lines = file.readString();
  file.close();
  return lines;
}

void savePurgedList(const String& lines) {
  SD_MMC.remove(PURGED_FILE);
  if (lines.length()) writeText(PURGED_FILE, lines);
}

}  // namespace Storage
