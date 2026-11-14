// Helmet camera firmware for the AI Thinker ESP32-CAM.
//
// What it does
//   1. Waits for the driver's phone to connect over Bluetooth LE.
//   2. On "start" it records video to the memory card in 10 second chunks.
//   3. On "stop" it keeps recording for a few more seconds, then finishes.
//   4. Whenever the phone hotspot is reachable it uploads finished recordings,
//      oldest first, each chunk signed with this helmet's secret.
//   5. Recordings stay on the card as a backup. When the card fills up, the
//      oldest recordings are deleted to make room.
//
// Bench test with no phone
//   Fill in DEFAULT_WIFI_SSID, DEFAULT_WIFI_PASS and DEFAULT_SERVER_URL in
//   config.h, flash, open the Serial Monitor at 115200 baud with line ending
//   set to "Newline", and type:
//       start TEST-1      begin recording as recording id TEST-1
//       stop              finish; the upload starts by itself
//       status            show Wi-Fi, server, card and upload queue
//       help              list every command
//
// Arduino IDE setup
//   Board:             AI Thinker ESP32-CAM  (esp32 boards package 3.x; built with 3.3.11)
//   Partition scheme:  Huge APP (3MB No OTA/1MB SPIFFS)
//   Libraries:         NimBLE-Arduino 2.x (built with 2.5.0), ArduinoJson 7.x (built with 7.4.3)
//
// Edit config.h before flashing: DEVICE_ID, DEVICE_SECRET and BLE_NAME.

#include <ArduinoJson.h>
#include <WiFi.h>
#include <sys/time.h>

#include "ble_link.h"
#include "config.h"
#include "console.h"
#include "recorder.h"
#include "settings.h"
#include "storage.h"
#include "uploader.h"

static const uint32_t STATUS_INTERVAL_MS = 2000;

static bool cardReady = false;
static String lastError;
static String lastStatus;
static uint32_t lastStatusMs = 0;

static void setClock(uint32_t epochSeconds) {
  if (epochSeconds < MIN_VALID_EPOCH) return;
  const struct timeval now = {(time_t)epochSeconds, 0};
  settimeofday(&now, nullptr);
}

// Recording ids become file contents and JSON values, so keep them boring.
static bool validRecordingId(const char* id) {
  const size_t length = strlen(id);
  if (length == 0 || length > 31) return false;
  for (size_t i = 0; i < length; i++) {
    const char c = id[i];
    if (!isalnum((unsigned char)c) && c != '-' && c != '_') return false;
  }
  return true;
}

// Starts a recording and remembers why it failed, if it did.
// Returns true when the camera is recording.
static bool startRecording(const char* id, double lat, double lon, bool watchPhoneLink) {
  if (!cardReady) {
    lastError = "sd card";
  } else if (!validRecordingId(id)) {
    lastError = "bad id";
  } else {
    const char* problem = Recorder::start(id, lat, lon, watchPhoneLink);
    lastError = problem ? problem : "";
  }
  lastStatusMs = 0;  // report the new state straight away
  return lastError.length() == 0;
}

static bool setServer(const String& url) {
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  Settings::setServerUrl(url);
  return true;
}

// ---- Commands from the phone (JSON over Bluetooth) ---------------------------------

static void handleCommand(const String& json) {
  JsonDocument doc;
  if (deserializeJson(doc, json)) {
    lastError = "bad command";
    return;
  }
  const char* cmd = doc["cmd"] | "";
  Console::printf("[cmd] %s\n", cmd);

  if (strcmp(cmd, "start") == 0) {
    setClock(doc["ts"] | 0UL);
    startRecording(doc["id"] | "", doc["lat"] | 0.0, doc["lon"] | 0.0, true);
  } else if (strcmp(cmd, "stop") == 0) {
    const uint32_t after = doc["after"] | DEFAULT_STOP_DELAY;
    Recorder::stop(after > 60 ? 60 : after);
  } else if (strcmp(cmd, "wifi") == 0) {
    Settings::setWifi(doc["ssid"] | "", doc["pass"] | "");
    Uploader::reconnect();
  } else if (strcmp(cmd, "server") == 0) {
    if (!setServer(doc["url"] | "")) lastError = "bad url";
  } else if (strcmp(cmd, "time") == 0) {
    setClock(doc["ts"] | 0UL);
  }
  lastStatusMs = 0;
}

// ---- Commands typed into the Serial Monitor (bench testing) --------------------------

static void printHelp() {
  Console::println("Commands:");
  Console::println("  start <id>            record as this recording id, for example  start TEST-1");
  Console::println("  stop                  finish recording; the upload starts by itself");
  Console::println("  status                show Wi-Fi, server, memory card and upload queue");
  Console::println("  wifi <name>,<pass>    join this Wi-Fi or hotspot");
  Console::println("  server <url>          upload to this server, for example  server http://192.168.43.10:3000");
  Console::println("  help                  show this list");
}

static void printStatus() {
  Console::printf("Helmet        %s\n", DEVICE_ID);
  if (Recorder::active()) {
    Console::printf("Recording     %s, %lu chunks so far\n", Recorder::currentId().c_str(),
                  (unsigned long)Recorder::chunksWritten());
  } else {
    Console::println("Recording     off");
  }
  if (Uploader::wifiConnected()) {
    Console::printf("Wi-Fi         connected to %s, address %s\n", WiFi.SSID().c_str(),
                  WiFi.localIP().toString().c_str());
  } else if (Settings::wifiSsid().length()) {
    Console::printf("Wi-Fi         trying to join %s\n", Settings::wifiSsid().c_str());
  } else {
    Console::println("Wi-Fi         not set. Use:  wifi <name>,<pass>");
  }
  if (Settings::serverUrl().length()) {
    Console::printf("Server        %s\n", Settings::serverUrl().c_str());
  } else {
    Console::println("Server        not set. Use:  server <url>");
  }
  if (cardReady) {
    Console::printf("Memory card   %lu MB free\n", (unsigned long)Storage::freeMB());
  } else {
    Console::println("Memory card   NOT FOUND. Insert a FAT32 card and reset.");
  }
  Console::printf("Upload queue  %lu recording(s) waiting\n", (unsigned long)Uploader::pending());
  Console::printf("Clock         %s\n", time(nullptr) >= (time_t)MIN_VALID_EPOCH ? "set" : "not set yet (set from Wi-Fi or the phone)");
  Console::printf("Phone link    %s\n", BleLink::connected() ? "connected" : "not connected");
  if (lastError.length()) Console::printf("Last problem  %s\n", lastError.c_str());
}

static void handleSerialLine(String line) {
  line.trim();
  if (!line.length()) return;
  const int space = line.indexOf(' ');
  String cmd = space < 0 ? line : line.substring(0, space);
  String arg = space < 0 ? String() : line.substring(space + 1);
  cmd.toLowerCase();
  arg.trim();

  if (cmd == "start") {
    // No phone is involved in a bench test, so a missing phone link is not flagged.
    if (startRecording(arg.c_str(), 0.0, 0.0, false)) {
      Console::printf("Recording %s. Type  stop  to finish.\n", arg.c_str());
      if (time(nullptr) < (time_t)MIN_VALID_EPOCH) {
        Console::println("Note: the clock is not set yet, so this video will be flagged. It sets itself once Wi-Fi connects.");
      }
    } else {
      Console::printf("Could not start: %s\n", lastError.c_str());
    }
  } else if (cmd == "stop") {
    if (Recorder::active()) {
      Recorder::stop(0);
      Console::println("Stopping. The upload begins once the last chunk is saved.");
    } else {
      Console::println("Not recording.");
    }
  } else if (cmd == "status") {
    printStatus();
  } else if (cmd == "wifi") {
    const int comma = arg.indexOf(',');
    if (comma < 1) {
      Console::println("Use:  wifi <name>,<pass>");
    } else {
      Settings::setWifi(arg.substring(0, comma), arg.substring(comma + 1));
      Uploader::reconnect();
      Console::println("Saved. Joining now.");
    }
  } else if (cmd == "server") {
    Console::println(setServer(arg) ? "Saved." : "The address must start with http:// or https://");
  } else {
    printHelp();
  }
}

static void pollSerial() {
  static String line;
  for (int next = Console::read(); next >= 0; next = Console::read()) {
    const char c = (char)next;
    if (c == '\n' || c == '\r') {
      handleSerialLine(line);
      line = "";
    } else if (line.length() < 200) {
      line += c;
    }
  }
}

// ---- Status to the phone -------------------------------------------------------------

// Asking the card for free space is slow, so only do it now and then.
static uint32_t freeSpaceMB() {
  static uint32_t value = 0, checkedMs = 0;
  if (!cardReady) return 0;
  if (checkedMs == 0 || millis() - checkedMs > 15000) {
    value = Storage::freeMB();
    checkedMs = millis();
  }
  return value;
}

static void publishStatus() {
  static uint32_t lastBuildMs = 0;
  if (lastStatusMs != 0 && millis() - lastBuildMs < 500) return;
  lastBuildMs = millis();

  JsonDocument doc;
  doc["st"] = Recorder::active() ? "rec" : "idle";
  doc["id"] = Recorder::currentId();
  doc["ch"] = Recorder::active() ? Recorder::chunksWritten() : 0;
  doc["q"] = Uploader::pending();
  doc["free"] = freeSpaceMB();
  doc["wifi"] = Uploader::wifiConnected() ? 1 : 0;
  doc["fl"] = Recorder::active() ? Recorder::flags() : 0;
  doc["err"] = cardReady ? lastError : String("sd card");

  String status;
  serializeJson(doc, status);
  const bool changed = status != lastStatus;
  if (!changed && millis() - lastStatusMs < STATUS_INTERVAL_MS) return;
  lastStatus = status;
  lastStatusMs = millis();
  BleLink::publishStatus(status);
}

// ---- Start up --------------------------------------------------------------------------

// Network settings written in config.h are applied once, on the first start
// after a flash that changed them. After that, a server address sent by the
// rider page or typed over serial is kept, even across restarts, so the board
// does not need reflashing when the site's address changes.
static void applyConfiguredNetwork() {
  const String ssid = DEFAULT_WIFI_SSID;
  const String pass = DEFAULT_WIFI_PASS;
  const String url = DEFAULT_SERVER_URL;
  const String defaults = ssid + "\n" + pass + "\n" + url;
  if (Settings::appliedDefaults() == defaults) return;
  if (ssid.length()) Settings::setWifi(ssid, pass);
  if (url.length()) setServer(url);
  Settings::setAppliedDefaults(defaults);
}

void setup() {
  Console::begin();
  Console::println("\nHelmet camera " DEVICE_ID " starting");

  pinMode(PIN_STATUS_LED, OUTPUT);
  digitalWrite(PIN_STATUS_LED, HIGH);  // off

  Settings::begin();
  applyConfiguredNetwork();

  cardReady = Storage::begin();
  // Mounting the card can leave the flash LED pin floating. Force it off.
  pinMode(PIN_FLASH_LED, OUTPUT);
  digitalWrite(PIN_FLASH_LED, LOW);

  if (cardReady) {
    Storage::recoverInterrupted();
    Console::printf("[storage] card ready, %lu MB free\n", (unsigned long)Storage::freeMB());
  } else {
    // Stay up so the phone can show the fault and block "Delivered".
    Console::println("[storage] no memory card found");
  }

  BleLink::begin();
  Recorder::begin();
  if (cardReady) Uploader::begin();
  Console::println("Ready. Type  help  for the bench test commands.");
}

void loop() {
  String json;
  while (BleLink::nextCommand(json)) handleCommand(json);
  pollSerial();
  publishStatus();
  delay(20);
}
