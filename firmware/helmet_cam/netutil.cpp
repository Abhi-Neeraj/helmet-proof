#include "netutil.h"

#include "config.h"

namespace Net {

bool parseServerUrl(const String& url, ServerAddress& out) {
  int start;
  if (url.startsWith("https://")) {
    out.https = true;
    start = 8;
  } else if (url.startsWith("http://")) {
    out.https = false;
    start = 7;
  } else {
    return false;
  }

  const int slash = url.indexOf('/', start);
  const String authority = slash < 0 ? url.substring(start) : url.substring(start, slash);
  out.basePath = slash < 0 ? String() : url.substring(slash);
  while (out.basePath.endsWith("/")) out.basePath.remove(out.basePath.length() - 1);

  const int colon = authority.lastIndexOf(':');
  if (colon > 0) {
    out.host = authority.substring(0, colon);
    out.port = (uint16_t)authority.substring(colon + 1).toInt();
  } else {
    out.host = authority;
    out.port = out.https ? 443 : 80;
  }
  return out.host.length() > 0 && out.port != 0;
}

String hostHeader(const ServerAddress& server) {
  String header = "Host: " + server.host;
  if (server.port != (server.https ? 443 : 80)) {
    header += ':';
    header += String((unsigned long)server.port);
  }
  return header;
}

bool writeAll(Client& client, const uint8_t* data, size_t length) {
  const uint32_t startedMs = millis();
  size_t sent = 0;
  while (sent < length) {
    if (!client.connected() || millis() - startedMs > IO_TIMEOUT_MS) return false;
    const size_t written = client.write(data + sent, length - sent);
    if (written == 0) {
      vTaskDelay(pdMS_TO_TICKS(10));
      continue;
    }
    sent += written;
  }
  return true;
}

String toHex(const uint8_t* bytes, size_t length) {
  static const char digits[] = "0123456789abcdef";
  String hex;
  hex.reserve(length * 2);
  for (size_t i = 0; i < length; i++) {
    hex += digits[bytes[i] >> 4];
    hex += digits[bytes[i] & 0x0f];
  }
  return hex;
}

Hmac::Hmac() {
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, (const uint8_t*)DEVICE_SECRET, strlen(DEVICE_SECRET));
}

Hmac::~Hmac() { mbedtls_md_free(&ctx); }

void Hmac::update(const uint8_t* data, size_t length) { mbedtls_md_hmac_update(&ctx, data, length); }

String Hmac::finish() {
  uint8_t digest[32];
  mbedtls_md_hmac_finish(&ctx, digest);
  return toHex(digest, sizeof(digest));
}

}  // namespace Net
