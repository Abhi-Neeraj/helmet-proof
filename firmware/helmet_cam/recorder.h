// Captures JPEG frames from the camera and writes them to the memory card
// in 10 second HCV chunks. The format is documented in server/src/chunk-format.js.
#pragma once

#include <Arduino.h>

namespace Recorder {

void begin();

// Starts a recording. Returns nullptr on success, or a short reason on failure.
// Starting the recording that is already running is treated as success.
//
// `watchPhoneLink` flags the video if the Bluetooth link to the phone drops
// while recording. Pass false for a bench test started from the serial
// monitor, where no phone is connected in the first place.
const char* start(const char* recordingId, double lat, double lon, bool watchPhoneLink = true);

// Stops after `afterSeconds`, so the handover itself is always on video.
void stop(uint32_t afterSeconds);

bool active();
String currentId();
uint32_t chunksWritten();
uint16_t flags();

}  // namespace Recorder
