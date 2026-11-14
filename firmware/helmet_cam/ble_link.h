// Bluetooth LE link to the driver's phone.
//
// The phone writes JSON commands to the command characteristic:
//   {"cmd":"start","id":"D1234-1","ts":1763000000,"lat":17.4485,"lon":78.3917}
//   {"cmd":"stop","after":10}
//   {"cmd":"wifi","ssid":"MyHotspot","pass":"secret"}
//   {"cmd":"server","url":"http://192.168.43.10:3000"}
//   {"cmd":"time","ts":1763000000}
//
// The helmet notifies JSON status on the status characteristic:
//   {"st":"rec","id":"D1234-1","ch":3,"q":1,"free":28114,"wifi":1,"fl":0,"err":""}
//   st    "idle" or "rec"
//   id    recording in progress, empty when idle
//   ch    chunks written so far
//   q     recordings waiting to upload
//   free  free space on the card in MB
//   wifi  1 when connected to the hotspot
//   fl    flags raised during this recording
//   err   last problem, empty when all is well
#pragma once

#include <Arduino.h>

namespace BleLink {

void begin();
bool connected();

// Pops the next command received from the phone. Returns false when there is none.
bool nextCommand(String& json);

void publishStatus(const String& json);

}  // namespace BleLink
