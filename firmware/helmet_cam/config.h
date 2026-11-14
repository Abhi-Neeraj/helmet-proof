// Helmet camera configuration.
#pragma once

#include <Arduino.h>

// ---- Identity and network ------------------------------------------------------
// The helmet's id, secret, Wi-Fi login and server address live in secrets.h,
// which git ignores. Copy secrets.example.h to secrets.h and fill it in.
#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

// ---- Bluetooth LE ------------------------------------------------------------
// The phone app uses the same three UUIDs.
#define BLE_SERVICE_UUID  "7a1c0001-5b0e-4f6a-9d3c-2e8f4b6a1c00"
#define BLE_COMMAND_UUID  "7a1c0002-5b0e-4f6a-9d3c-2e8f4b6a1c00"  // phone writes JSON commands
#define BLE_STATUS_UUID   "7a1c0003-5b0e-4f6a-9d3c-2e8f4b6a1c00"  // helmet notifies JSON status

// ---- Recording ---------------------------------------------------------------
#define FRAME_SIZE           FRAMESIZE_VGA  // 640 x 480
#define JPEG_QUALITY         12             // 10 = best, 63 = worst
#define TARGET_FPS           10
#define CHUNK_SECONDS        10             // video is saved and uploaded in pieces this long
#define MAX_RECORD_SECONDS   300            // hard stop, so a stuck session cannot drain the battery
#define DEFAULT_STOP_DELAY   10             // seconds kept recording after "Delivered"
#define CAMERA_VFLIP         0              // set to 1 if the picture is upside down
#define CAMERA_HMIRROR       0              // set to 1 if the picture is mirrored

// A chunk whose average frame is smaller than this is flagged as "possible lens cover".
// Covered or pitch dark frames compress to almost nothing.
#define LOW_DETAIL_BYTES     6000

// ---- Storage -----------------------------------------------------------------
// When free space drops below this, the oldest recordings are deleted to make room.
#define MIN_FREE_MB          100

// ---- Pins (AI Thinker ESP32-CAM) ----------------------------------------------
#define PIN_STATUS_LED   33   // small red LED on the back, on when LOW. Lit while recording.
#define PIN_FLASH_LED     4   // white flash LED. Kept off.

#define CAM_PIN_PWDN     32
#define CAM_PIN_RESET    -1
#define CAM_PIN_XCLK      0
#define CAM_PIN_SIOD     26
#define CAM_PIN_SIOC     27
#define CAM_PIN_D7       35
#define CAM_PIN_D6       34
#define CAM_PIN_D5       39
#define CAM_PIN_D4       36
#define CAM_PIN_D3       21
#define CAM_PIN_D2       19
#define CAM_PIN_D1       18
#define CAM_PIN_D0        5
#define CAM_PIN_VSYNC    25
#define CAM_PIN_HREF     23
#define CAM_PIN_PCLK     22

// ---- Chunk flags (must match server/src/chunk-format.js) -----------------------
#define FLAG_LOW_DETAIL     0x01
#define FLAG_LINK_LOST      0x02
#define FLAG_TIMEOUT        0x04
#define FLAG_TIME_UNSYNCED  0x08
#define FLAG_CAMERA_FAULT   0x10

// Any clock value before this (Nov 2023) means the clock was never set.
#define MIN_VALID_EPOCH  1700000000UL
