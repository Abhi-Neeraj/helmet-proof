// Joins the phone hotspot and uploads finished recordings in the order they
// were made. With no network, recordings simply wait on the card.
#pragma once

#include <Arduino.h>

namespace Uploader {

void begin();

// Call after the Wi-Fi settings change so the new ones are used straight away.
void reconnect();

bool wifiConnected();

// Recordings finished but not yet fully uploaded.
uint32_t pending();

}  // namespace Uploader
