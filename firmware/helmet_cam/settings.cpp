#include "settings.h"

#include <Preferences.h>

namespace {

Preferences prefs;

// Cached in RAM so readers never touch flash.
String ssid, pass, url;
volatile uint32_t next = 0, oldest = 0, upSeq = 0, upIdx = 0;

}  // namespace

namespace Settings {

void begin() {
  prefs.begin("helmet", false);
  ssid = prefs.getString("ssid", "");
  pass = prefs.getString("pass", "");
  url = prefs.getString("url", "");
  next = prefs.getUInt("next", 0);
  oldest = prefs.getUInt("oldest", 0);
  upSeq = prefs.getUInt("upSeq", 0);
  upIdx = prefs.getUInt("upIdx", 0);
}

String wifiSsid() { return ssid; }
String wifiPass() { return pass; }
String serverUrl() { return url; }

void setWifi(const String& newSsid, const String& newPass) {
  ssid = newSsid;
  pass = newPass;
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
}

void setServerUrl(const String& newUrl) {
  url = newUrl;
  while (url.endsWith("/")) url.remove(url.length() - 1);
  prefs.putString("url", url);
}

String appliedDefaults() { return prefs.getString("defaults", ""); }

void setAppliedDefaults(const String& value) { prefs.putString("defaults", value); }

uint32_t nextSeq() { return next; }
uint32_t oldestSeq() { return oldest; }
uint32_t uploadSeq() { return upSeq; }
uint32_t uploadIdx() { return upIdx; }

void setNextSeq(uint32_t value) {
  next = value;
  prefs.putUInt("next", value);
}

void setOldestSeq(uint32_t value) {
  oldest = value;
  prefs.putUInt("oldest", value);
}

void setUploadPosition(uint32_t seq, uint32_t idx) {
  if (seq != upSeq) {
    upSeq = seq;
    prefs.putUInt("upSeq", seq);
  }
  upIdx = idx;
  prefs.putUInt("upIdx", idx);
}

}  // namespace Settings
