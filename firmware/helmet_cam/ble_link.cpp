#include "ble_link.h"

#include <NimBLEDevice.h>

#include "config.h"
#include "console.h"

namespace {

const size_t MAX_COMMAND = 256;

struct Command {
  char json[MAX_COMMAND];
};

QueueHandle_t commands = nullptr;
NimBLECharacteristic* statusChar = nullptr;
volatile bool linkUp = false;

// Written for NimBLE-Arduino 2.x. Version 1.x used different callback
// signatures and will not compile with this file.
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server, NimBLEConnInfo& connInfo) override {
    linkUp = true;
    Console::println("[ble] phone connected");
  }

  void onDisconnect(NimBLEServer* server, NimBLEConnInfo& connInfo, int reason) override {
    linkUp = false;
    Console::println("[ble] phone disconnected");
    NimBLEDevice::startAdvertising();
  }
};

// Runs on the Bluetooth task, so it only copies the text and returns.
class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic, NimBLEConnInfo& connInfo) override {
    const std::string value = characteristic->getValue();
    if (value.empty() || value.size() >= MAX_COMMAND) return;
    Command command;
    memcpy(command.json, value.data(), value.size());
    command.json[value.size()] = '\0';
    xQueueSend(commands, &command, 0);
  }
};

}  // namespace

namespace BleLink {

void begin() {
  commands = xQueueCreate(4, sizeof(Command));

  NimBLEDevice::init(BLE_NAME);
  NimBLEDevice::setMTU(247);
  NimBLEDevice::setPower(9);  // dBm, the most the ESP32 allows

  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  NimBLEService* service = server->createService(BLE_SERVICE_UUID);
  NimBLECharacteristic* commandChar =
      service->createCharacteristic(BLE_COMMAND_UUID, NIMBLE_PROPERTY::WRITE);
  commandChar->setCallbacks(new CommandCallbacks());
  statusChar = service->createCharacteristic(
      BLE_STATUS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  server->start();  // starts every service created above

  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  // The service id fills most of the advertisement, so the name goes in the
  // scan response. Without this the phone would list the helmet with no name.
  advertising->setName(BLE_NAME);
  advertising->enableScanResponse(true);
  advertising->start();
  Console::printf("[ble] advertising as %s\n", BLE_NAME);
}

bool connected() { return linkUp; }

bool nextCommand(String& json) {
  Command command;
  if (xQueueReceive(commands, &command, 0) != pdTRUE) return false;
  json = command.json;
  return true;
}

void publishStatus(const String& json) {
  if (!statusChar) return;
  statusChar->setValue((const uint8_t*)json.c_str(), json.length());
  if (linkUp) statusChar->notify();
}

}  // namespace BleLink
