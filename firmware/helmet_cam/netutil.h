// Small pieces shared by the uploader and the live sender: the server address,
// request signing, and writing to a connection.
#pragma once

#include <Arduino.h>
#include <Client.h>
#include <mbedtls/md.h>

namespace Net {

const uint32_t CONNECT_TIMEOUT_MS = 8000;
const uint32_t IO_TIMEOUT_MS = 20000;

struct ServerAddress {
  bool https = false;
  String host;
  uint16_t port = 0;
  String basePath;  // normally empty
};

// Splits "https://example.com:8443/base" into its parts.
bool parseServerUrl(const String& url, ServerAddress& out);

// "Host: example.com" or "Host: example.com:8443", ready for a request.
String hostHeader(const ServerAddress& server);

// Writes every byte, or gives up when the link stalls.
bool writeAll(Client& client, const uint8_t* data, size_t length);

String toHex(const uint8_t* bytes, size_t length);

// HMAC SHA256 with this helmet's secret. The server checks it on every request.
class Hmac {
 public:
  Hmac();
  ~Hmac();
  void update(const uint8_t* data, size_t length);
  String finish();  // lower case hex

 private:
  mbedtls_md_context_t ctx;
};

}  // namespace Net
