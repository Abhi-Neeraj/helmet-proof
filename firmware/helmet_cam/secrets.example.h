// Example of a helmet's private settings.
//
// Copy this file to secrets.h (same folder) and fill it in. secrets.h is
// ignored by git, so a helmet's secret and your Wi-Fi password never end up
// in the repository. Without secrets.h the firmware still builds, using these
// placeholders, but the server will refuse its uploads.
#pragma once

// ---- Identity ---------------------------------------------------------------
// Each helmet needs its own id and secret. In the dashboard go to
// Admin > Helmets, add the helmet, press "Show config", and paste the lines it
// shows here. The server rejects every upload from a helmet it does not know.
#define DEVICE_ID      "HELMET-001"
#define DEVICE_SECRET  "paste-the-secret-from-the-dashboard"
#define BLE_NAME       "HelmetCam-001"

// ---- Network ----------------------------------------------------------------
// Filled in values are applied on the first start after flashing. After that,
// the rider page on the phone sends the site's current address each time it
// connects to the helmet, and the helmet keeps it. A server address typed in
// the Serial Monitor (server <address>) is kept too. Leave empty to rely on
// the rider page.
#define DEFAULT_WIFI_SSID   ""   // your phone hotspot or Wi-Fi name
#define DEFAULT_WIFI_PASS   ""
#define DEFAULT_SERVER_URL  ""   // for example "https://your-site-address"
