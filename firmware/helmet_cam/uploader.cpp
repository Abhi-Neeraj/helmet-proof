#include "uploader.h"

#include <SD_MMC.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "config.h"
#include "console.h"
#include "netutil.h"
#include "recorder.h"
#include "settings.h"
#include "storage.h"

namespace {

enum class Result {
  Idle,      // nothing to do
  Done,      // one step finished, more may follow
  Retry,     // network or server trouble; wait and try the same step again
  Rejected,  // server refused this item for good; skip it so the queue keeps moving
};

const uint32_t WIFI_RETRY_MS = 20000;
const uint32_t MIN_BACKOFF_MS = 2000;
const uint32_t MAX_BACKOFF_MS = 60000;

volatile bool reconnectRequested = false;
uint32_t lastWifiAttemptMs = 0;
bool clockSyncStarted = false;

using Net::Hmac;
using Net::ServerAddress;
using Net::parseServerUrl;
using Net::writeAll;
using Net::CONNECT_TIMEOUT_MS;
using Net::IO_TIMEOUT_MS;

// ---- Signing -----------------------------------------------------------------

String signFile(File& file) {
  Hmac hmac;
  uint8_t buffer[2048];
  file.seek(0);
  while (file.available()) {
    const size_t read = file.read(buffer, sizeof(buffer));
    if (read == 0) break;
    hmac.update(buffer, read);
  }
  file.seek(0);
  return hmac.finish();
}

String signText(const String& text) {
  Hmac hmac;
  hmac.update((const uint8_t*)text.c_str(), text.length());
  return hmac.finish();
}

// ---- HTTP --------------------------------------------------------------------
//
// A small hand written HTTP client. The Arduino HTTPClient library is left out
// on purpose: its cookie support links in date parsing code, and the ESP32-CAM
// board places that code in IRAM. With Wi-Fi, Bluetooth and the camera in the
// same sketch, IRAM then overflows and the sketch does not link.

// Reads the first line of the reply, "HTTP/1.1 200 OK", and returns the number.
// Returns -1 when no usable reply arrives in time.
int readStatus(Client& client) {
  const uint32_t startedMs = millis();
  String line;
  while (millis() - startedMs < IO_TIMEOUT_MS) {
    while (client.available()) {
      const char c = (char)client.read();
      if (c == '\n') {
        const int space = line.indexOf(' ');
        const int status = space < 0 ? 0 : (int)line.substring(space + 1, space + 4).toInt();
        return status > 0 ? status : -1;
      }
      if (line.length() < 64) line += c;
    }
    if (!client.connected() && !client.available()) break;
    vTaskDelay(pdMS_TO_TICKS(10));
  }
  return -1;
}

Result classify(int status) {
  if (status >= 200 && status < 300) return Result::Done;
  // The server understood the request and will never accept it. 401 is not in
  // this list on purpose: a wrong secret is a setup mistake, and the evidence
  // should wait on the card until it is fixed.
  if (status == 400 || status == 404 || status == 409 || status == 413 || status == 422) {
    return Result::Rejected;
  }
  return Result::Retry;
}

// Sends one signed POST. Pass either a file or a JSON body.
Result post(const char* path, File* file, const String& json) {
  ServerAddress server;
  if (!parseServerUrl(Settings::serverUrl(), server)) {
    Console::println("[upload] the server address is not valid. Use:  server http://<address>:3000");
    return Result::Retry;
  }
  const String signature = file ? signFile(*file) : signText(json);
  const size_t length = file ? file->size() : json.length();

  WiFiClient plain;
  WiFiClientSecure secure;
  bool connected;
  if (server.https) {
    // The certificate is not checked here. Uploads are still signed, so a fake
    // server cannot forge evidence, but pin your server's CA before production.
    secure.setInsecure();
    connected = secure.connect(server.host.c_str(), server.port, CONNECT_TIMEOUT_MS);
  } else {
    connected = plain.connect(server.host.c_str(), server.port, CONNECT_TIMEOUT_MS);
  }
  if (!connected) {
    Console::printf("[upload] could not reach %s\n", Settings::serverUrl().c_str());
    static String hinted;
    if (hinted != Settings::serverUrl()) {
      hinted = Settings::serverUrl();
      Console::println("[upload] If the site's address has changed, open the rider page on the phone and "
                       "connect the helmet, or type:  server <new address>");
    }
    return Result::Retry;
  }
  Client& client = server.https ? static_cast<Client&>(secure) : static_cast<Client&>(plain);

  String head;
  head.reserve(400);
  head += "POST ";
  head += server.basePath;
  head += path;
  head += " HTTP/1.1\r\nHost: ";
  head += server.host;
  if (server.port != (server.https ? 443 : 80)) {
    head += ':';
    head += String((unsigned long)server.port);
  }
  head += "\r\nUser-Agent: helmet-cam\r\nConnection: close\r\nX-Device-Id: " DEVICE_ID "\r\nX-Signature: ";
  head += signature;
  head += "\r\nContent-Type: ";
  head += file ? "application/octet-stream" : "application/json";
  head += "\r\nContent-Length: ";
  head += String((unsigned long)length);
  head += "\r\n\r\n";

  bool sent = writeAll(client, (const uint8_t*)head.c_str(), head.length());
  if (sent && file) {
    // Stream the chunk from the card in small pieces; it does not fit in memory.
    uint8_t buffer[2048];
    size_t remaining = length;
    while (sent && remaining > 0) {
      const size_t want = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
      const size_t got = file->read(buffer, want);
      if (got == 0) {  // the card stopped answering
        sent = false;
        break;
      }
      sent = writeAll(client, buffer, got);
      remaining -= got;
    }
  } else if (sent) {
    sent = writeAll(client, (const uint8_t*)json.c_str(), json.length());
  }

  const int status = sent ? readStatus(client) : -1;
  client.stop();
  if (status < 0) {  // the link dropped part way, or the server never answered
    Console::printf("[upload] lost the connection to %s, will try again\n", server.host.c_str());
    return Result::Retry;
  }
  const Result result = classify(status);
  if (result != Result::Done) Console::printf("[upload] %s -> HTTP %d\n", path, status);
  if (status == 401) {
    Console::println("[upload] the server does not know this helmet. Check that DEVICE_ID and "
                   "DEVICE_SECRET in config.h match Admin > Helmets in the dashboard.");
  }
  return result;
}

Result postJson(const char* path, const String& json) { return post(path, nullptr, json); }

Result postChunk(const String& chunkPath) {
  File file = SD_MMC.open(chunkPath, FILE_READ);
  if (!file) return Result::Rejected;
  const Result result = post("/api/device/chunks", &file, "");
  file.close();
  return result;
}

// ---- Queue -------------------------------------------------------------------

// Tells the server about recordings that were deleted before upload.
Result reportPurged() {
  String lines = Storage::takePurgedList();
  if (!lines.length()) return Result::Idle;

  while (lines.length()) {
    const int lineEnd = lines.indexOf('\n');
    String id = lineEnd < 0 ? lines : lines.substring(0, lineEnd);
    id.trim();
    if (id.length() && postJson("/api/device/purged", "{\"id\":\"" + id + "\"}") == Result::Retry) {
      Storage::savePurgedList(lines);  // keep what is left for next time
      return Result::Retry;
    }
    lines = lineEnd < 0 ? String() : lines.substring(lineEnd + 1);
  }
  Storage::savePurgedList("");
  return Result::Done;
}

// Sends the next chunk, or the "recording complete" notice once all chunks are in.
Result uploadNext() {
  const Result purged = reportPurged();
  if (purged == Result::Retry) return purged;

  const uint32_t seq = Settings::uploadSeq();
  if (seq >= Settings::nextSeq()) return Result::Idle;

  const String dir = Storage::recordingDir(seq);
  if (!SD_MMC.exists(dir)) {  // card was swapped or wiped
    Settings::setUploadPosition(seq + 1, 0);
    return Result::Done;
  }

  const String end = Storage::readText(dir + "/END");
  if (!end.length()) return Result::Idle;  // still being recorded
  const uint32_t total = (uint32_t)end.toInt();
  const bool interrupted = end.endsWith(",1");

  const uint32_t idx = Settings::uploadIdx();
  if (idx < total) {
    const String chunk = Storage::chunkPath(seq, idx);
    if (SD_MMC.exists(chunk)) {
      const Result sent = postChunk(chunk);
      if (sent == Result::Retry) return Result::Retry;
      Console::printf("[upload] chunk %lu of %lu %s\n", (unsigned long)(idx + 1), (unsigned long)total,
                    sent == Result::Done ? "sent" : "refused by the server, skipped");
    }
    Settings::setUploadPosition(seq, idx + 1);
    return Result::Done;
  }

  const String id = Storage::readText(dir + "/ID");
  const String body = "{\"id\":\"" + id + "\",\"chunks\":" + String(total) +
                      ",\"interrupted\":" + (interrupted ? "true" : "false") + "}";
  if (id.length() && postJson("/api/device/complete", body) == Result::Retry) return Result::Retry;
  Console::printf("[upload] recording %s fully uploaded\n", id.c_str());
  Settings::setUploadPosition(seq + 1, 0);
  return Result::Done;
}

// ---- Wi-Fi -------------------------------------------------------------------

void maintainWifi() {
  if (reconnectRequested) {
    reconnectRequested = false;
    WiFi.disconnect();
    lastWifiAttemptMs = 0;
  }
  if (WiFi.status() == WL_CONNECTED) return;

  const String ssid = Settings::wifiSsid();
  if (!ssid.length()) return;
  if (lastWifiAttemptMs && millis() - lastWifiAttemptMs < WIFI_RETRY_MS) return;
  lastWifiAttemptMs = millis();
  WiFi.begin(ssid.c_str(), Settings::wifiPass().c_str());
}

void uploaderTask(void*) {
  uint32_t backoffMs = MIN_BACKOFF_MS;
  bool wasOnline = false;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(1000));
    maintainWifi();

    const bool online = WiFi.status() == WL_CONNECTED;
    if (online != wasOnline) {
      wasOnline = online;
      if (online) {
        Console::printf("[wifi] connected to %s, address %s\n", WiFi.SSID().c_str(),
                      WiFi.localIP().toString().c_str());
      } else {
        Console::println("[wifi] disconnected");
      }
    }
    if (!online || !Settings::serverUrl().length()) continue;

    // The phone normally sets the clock. This is a fallback for a helmet that rebooted.
    if (!clockSyncStarted && time(nullptr) < (time_t)MIN_VALID_EPOCH) {
      configTime(0, 0, "pool.ntp.org");
      clockSyncStarted = true;
    }

    // Recording has priority on the card and the processor. Uploads wait for it.
    while (!Recorder::active() && WiFi.status() == WL_CONNECTED) {
      if (!Storage::lock(2000)) break;
      const Result result = uploadNext();
      Storage::unlock();

      if (result == Result::Idle) break;
      if (result == Result::Retry) {
        vTaskDelay(pdMS_TO_TICKS(backoffMs));
        backoffMs = backoffMs * 2 > MAX_BACKOFF_MS ? MAX_BACKOFF_MS : backoffMs * 2;
        break;
      }
      backoffMs = MIN_BACKOFF_MS;
    }
  }
}

}  // namespace

namespace Uploader {

void begin() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  // 16 KB of stack leaves room for a TLS handshake when the server URL is https.
  xTaskCreatePinnedToCore(uploaderTask, "uploader", 16384, nullptr, 1, nullptr, 1);
}

void reconnect() { reconnectRequested = true; }

bool wifiConnected() { return WiFi.status() == WL_CONNECTED; }

uint32_t pending() {
  const uint32_t waiting = Settings::nextSeq() - Settings::uploadSeq();
  return Recorder::active() && waiting > 0 ? waiting - 1 : waiting;
}

}  // namespace Uploader
