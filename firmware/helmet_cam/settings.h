// Values that survive a power cycle, kept in the ESP32's flash (NVS).
#pragma once

#include <Arduino.h>

namespace Settings {

void begin();

// Network settings, sent by the phone over Bluetooth.
String wifiSsid();
String wifiPass();
String serverUrl();
void setWifi(const String& ssid, const String& pass);
void setServerUrl(const String& url);

// The network values from config.h that were applied last, so a fresh flash
// can be told apart from an ordinary restart.
String appliedDefaults();
void setAppliedDefaults(const String& value);

// Recording bookkeeping. Every recording gets the next sequence number, and its
// files live in /rec/<sequence>/ on the memory card.
//   nextSeq    the number the next recording will get
//   oldestSeq  the oldest recording still on the card
//   uploadSeq  the recording currently being uploaded; everything below is uploaded
//   uploadIdx  the next chunk of uploadSeq to send
uint32_t nextSeq();
uint32_t oldestSeq();
uint32_t uploadSeq();
uint32_t uploadIdx();
void setNextSeq(uint32_t value);
void setOldestSeq(uint32_t value);
void setUploadPosition(uint32_t seq, uint32_t idx);

}  // namespace Settings
