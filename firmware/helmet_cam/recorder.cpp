#include "recorder.h"

#include <SD_MMC.h>
#include <esp_camera.h>
#include <esp_log.h>

#include "ble_link.h"
#include "config.h"
#include "console.h"
#include "settings.h"
#include "storage.h"

namespace {

// On disk layout. Must match server/src/chunk-format.js.
struct __attribute__((packed)) ChunkHeader {
  char magic[4];  // "HCV1"
  uint16_t flags;
  uint16_t headerSize;
  uint32_t chunkIndex;
  uint32_t startEpoch;
  uint32_t frameCount;
  uint32_t durationMs;
  int32_t latE7;
  int32_t lonE7;
  char recordingId[32];
};
static_assert(sizeof(ChunkHeader) == 64, "chunk header must be 64 bytes");

struct __attribute__((packed)) FrameHeader {
  uint32_t offsetMs;  // since the recording started
  uint32_t length;
};

const uint32_t FRAME_PERIOD_MS = 1000 / TARGET_FPS;
const int MAX_CAPTURE_FAILURES = 20;

TaskHandle_t task = nullptr;

// Written by start() before `running` is set, then owned by the recorder task.
char recordingId[32] = "";
uint32_t seq = 0;
int32_t latE7 = 0, lonE7 = 0;
bool watchLink = true;

volatile bool running = false;
volatile bool stopRequested = false;
volatile uint32_t stopAtMs = 0;
volatile uint32_t chunkCount = 0;
volatile uint16_t recordingFlags = 0;

bool initCamera() {
  // The camera driver probes several I2C addresses to find the sensor, and
  // every miss prints an "I2C hardware timeout" error. They are harmless; a
  // real failure still makes esp_camera_init fail and is reported as "camera".
  esp_log_level_set("i2c.master", ESP_LOG_NONE);

  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = CAM_PIN_D0;
  config.pin_d1 = CAM_PIN_D1;
  config.pin_d2 = CAM_PIN_D2;
  config.pin_d3 = CAM_PIN_D3;
  config.pin_d4 = CAM_PIN_D4;
  config.pin_d5 = CAM_PIN_D5;
  config.pin_d6 = CAM_PIN_D6;
  config.pin_d7 = CAM_PIN_D7;
  config.pin_xclk = CAM_PIN_XCLK;
  config.pin_pclk = CAM_PIN_PCLK;
  config.pin_vsync = CAM_PIN_VSYNC;
  config.pin_href = CAM_PIN_HREF;
  config.pin_sccb_sda = CAM_PIN_SIOD;
  config.pin_sccb_scl = CAM_PIN_SIOC;
  config.pin_pwdn = CAM_PIN_PWDN;
  config.pin_reset = CAM_PIN_RESET;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAME_SIZE;
  config.jpeg_quality = JPEG_QUALITY;
  config.fb_count = 2;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.grab_mode = CAMERA_GRAB_LATEST;

  if (esp_camera_init(&config) != ESP_OK) return false;

  sensor_t* sensor = esp_camera_sensor_get();
  if (sensor) {
    sensor->set_vflip(sensor, CAMERA_VFLIP);
    sensor->set_hmirror(sensor, CAMERA_HMIRROR);
  }
  // The first frames are badly exposed while the sensor settles. Throw them away.
  for (int i = 0; i < 5; i++) {
    camera_fb_t* frame = esp_camera_fb_get();
    if (frame) esp_camera_fb_return(frame);
  }
  return true;
}

bool timeToStop(uint32_t recordingStartMs) {
  if (stopRequested && (int32_t)(millis() - stopAtMs) >= 0) return true;
  if (millis() - recordingStartMs >= MAX_RECORD_SECONDS * 1000UL) {
    recordingFlags |= FLAG_TIMEOUT;
    return true;
  }
  return false;
}

// Writes one chunk. Returns false when the recording must end.
bool writeChunk(uint32_t index, uint32_t recordingStartMs) {
  const String tempPath = Storage::tempChunkPath(seq, index);
  File file = SD_MMC.open(tempPath, FILE_WRITE);
  if (!file) {
    recordingFlags |= FLAG_CAMERA_FAULT;
    return false;
  }

  ChunkHeader header = {};
  memcpy(header.magic, "HCV1", 4);
  header.headerSize = sizeof(ChunkHeader);
  header.chunkIndex = index;
  header.startEpoch = (uint32_t)time(nullptr);
  header.latE7 = latE7;
  header.lonE7 = lonE7;
  strncpy(header.recordingId, recordingId, sizeof(header.recordingId) - 1);
  // Written now as a placeholder and rewritten with the final counts on close,
  // so a chunk cut off by power loss still has a readable header.
  file.write((const uint8_t*)&header, sizeof(header));

  uint16_t chunkFlags = header.startEpoch < MIN_VALID_EPOCH ? FLAG_TIME_UNSYNCED : 0;
  uint32_t frames = 0, bytes = 0, firstMs = 0, lastMs = 0;
  int failures = 0;
  bool keepGoing = true;
  const uint32_t chunkStartMs = millis();

  while (millis() - chunkStartMs < CHUNK_SECONDS * 1000UL) {
    if (timeToStop(recordingStartMs)) {
      keepGoing = false;
      break;
    }
    const uint32_t frameStartMs = millis();

    camera_fb_t* frame = esp_camera_fb_get();
    if (!frame) {
      if (++failures > MAX_CAPTURE_FAILURES) {
        chunkFlags |= FLAG_CAMERA_FAULT;
        keepGoing = false;
        break;
      }
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    failures = 0;

    const FrameHeader frameHeader = {frameStartMs - recordingStartMs, (uint32_t)frame->len};
    const bool written =
        file.write((const uint8_t*)&frameHeader, sizeof(frameHeader)) == sizeof(frameHeader) &&
        file.write(frame->buf, frame->len) == frame->len;
    const uint32_t length = frame->len;
    esp_camera_fb_return(frame);

    if (!written) {  // card full, removed, or failing
      chunkFlags |= FLAG_CAMERA_FAULT;
      keepGoing = false;
      break;
    }
    if (frames == 0) firstMs = frameHeader.offsetMs;
    lastMs = frameHeader.offsetMs;
    frames++;
    bytes += length;
    if (watchLink && !BleLink::connected()) chunkFlags |= FLAG_LINK_LOST;

    const uint32_t spent = millis() - frameStartMs;
    if (spent < FRAME_PERIOD_MS) vTaskDelay(pdMS_TO_TICKS(FRAME_PERIOD_MS - spent));
  }

  recordingFlags |= chunkFlags;
  if (frames == 0) {  // stopped before the first frame: nothing worth keeping
    file.close();
    SD_MMC.remove(tempPath);
    return keepGoing;
  }
  if (bytes / frames < LOW_DETAIL_BYTES) chunkFlags |= FLAG_LOW_DETAIL;
  recordingFlags |= chunkFlags;

  header.flags = chunkFlags | (recordingFlags & FLAG_TIMEOUT);
  header.frameCount = frames;
  header.durationMs = lastMs - firstMs;
  file.seek(0);
  file.write((const uint8_t*)&header, sizeof(header));
  file.close();

  // Renaming marks the chunk as complete and ready for upload.
  SD_MMC.rename(tempPath, Storage::chunkPath(seq, index));
  chunkCount = index + 1;
  return keepGoing;
}

void recorderTask(void*) {
  for (;;) {
    if (!running) {
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(500));
      continue;
    }

    Console::printf("[rec] recording %s as #%lu\n", recordingId, (unsigned long)seq);
    const uint32_t recordingStartMs = millis();
    while (writeChunk(chunkCount, recordingStartMs)) {
      Storage::ensureSpace(seq);  // loop recording: drop the oldest when the card fills
    }

    Storage::writeText(Storage::recordingDir(seq) + "/END", String(chunkCount) + ",0");
    esp_camera_deinit();
    digitalWrite(PIN_STATUS_LED, HIGH);  // off
    Console::printf("[rec] stopped %s after %lu chunks, flags 0x%02x\n", recordingId,
                  (unsigned long)chunkCount, recordingFlags);
    running = false;
  }
}

}  // namespace

namespace Recorder {

void begin() {
  // Core 1 keeps capture away from the Wi-Fi and Bluetooth stacks on core 0.
  xTaskCreatePinnedToCore(recorderTask, "recorder", 8192, nullptr, 2, &task, 1);
}

const char* start(const char* id, double lat, double lon, bool watchPhoneLink) {
  if (running) return strcmp(id, recordingId) == 0 ? nullptr : "busy";
  if (!psramFound()) return "no psram";

  const uint32_t newSeq = Settings::nextSeq();
  Storage::ensureSpace(newSeq);
  if (!initCamera()) return "camera";
  if (!Storage::createRecording(newSeq, id)) {
    esp_camera_deinit();
    return "sd card";
  }
  Settings::setNextSeq(newSeq + 1);

  strncpy(recordingId, id, sizeof(recordingId) - 1);
  recordingId[sizeof(recordingId) - 1] = '\0';
  seq = newSeq;
  latE7 = (int32_t)lround(lat * 1e7);
  lonE7 = (int32_t)lround(lon * 1e7);
  watchLink = watchPhoneLink;
  chunkCount = 0;
  recordingFlags = 0;
  stopRequested = false;

  digitalWrite(PIN_STATUS_LED, LOW);  // on: tells people nearby the camera is recording
  running = true;
  xTaskNotifyGive(task);
  return nullptr;
}

void stop(uint32_t afterSeconds) {
  if (!running) return;
  stopAtMs = millis() + afterSeconds * 1000UL;
  stopRequested = true;
}

bool active() { return running; }
String currentId() { return running ? String(recordingId) : String(); }
uint32_t chunksWritten() { return chunkCount; }
uint16_t flags() { return recordingFlags; }

}  // namespace Recorder
