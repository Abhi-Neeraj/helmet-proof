import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

import '../config.dart';
import '../models.dart';
import 'app_store.dart';

/// Bluetooth connection to the helmet camera.
///
/// Once [connect] is called the link is kept alive: if the helmet goes out of
/// range or loses power, the app keeps trying until it is back.
class HelmetLink extends ChangeNotifier {
  HelmetLink(this._store);

  final AppStore _store;

  BluetoothDevice? _device;
  BluetoothCharacteristic? _command;
  StreamSubscription<BluetoothConnectionState>? _stateSubscription;
  Timer? _retryTimer;
  bool _connecting = false;

  bool connected = false;
  HelmetStatus? status;

  /// Finds helmets that are switched on nearby.
  Future<List<ScanResult>> scan() async {
    final found = <String, ScanResult>{};
    final subscription = FlutterBluePlus.onScanResults.listen((results) {
      for (final result in results) {
        found[result.device.remoteId.str] = result;
      }
    });
    try {
      await FlutterBluePlus.startScan(withServices: [BleUuids.service]);
      await Future<void>.delayed(const Duration(seconds: 6));
      await FlutterBluePlus.stopScan();
    } finally {
      await subscription.cancel();
    }
    return found.values.toList();
  }

  /// Connects to the helmet with this Bluetooth id and stays connected.
  Future<void> connect(String remoteId) async {
    if (_device?.remoteId.str != remoteId) {
      await _stateSubscription?.cancel();
      await _device?.disconnect();
      _device = BluetoothDevice.fromId(remoteId);
      _stateSubscription = _device!.connectionState.listen(_onConnectionState);
    }
    await _tryConnect();
  }

  Future<void> _tryConnect() async {
    final device = _device;
    if (device == null || _connecting || connected) return;
    _connecting = true;
    try {
      await device.connect(timeout: const Duration(seconds: 12));
      final services = await device.discoverServices();
      final service = services.firstWhere((s) => s.uuid == BleUuids.service);
      _command = service.characteristics.firstWhere((c) => c.uuid == BleUuids.command);
      final statusChar = service.characteristics.firstWhere((c) => c.uuid == BleUuids.status);

      final subscription = statusChar.onValueReceived.listen(_onStatus);
      device.cancelWhenDisconnected(subscription);
      await statusChar.setNotifyValue(true);
      _onStatus(await statusChar.read());

      connected = true;
      notifyListeners();
      await pushSettings();
    } catch (_) {
      connected = false;
      _scheduleRetry();
    } finally {
      _connecting = false;
    }
  }

  void _onConnectionState(BluetoothConnectionState state) {
    if (state != BluetoothConnectionState.disconnected) return;
    final wasConnected = connected;
    connected = false;
    _command = null;
    if (wasConnected) notifyListeners();
    _scheduleRetry();
  }

  void _scheduleRetry() {
    _retryTimer?.cancel();
    _retryTimer = Timer(const Duration(seconds: 5), _tryConnect);
  }

  void _onStatus(List<int> bytes) {
    if (bytes.isEmpty) return;
    try {
      status = HelmetStatus.fromJson(jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>);
      notifyListeners();
    } catch (_) {
      // A status that does not parse is ignored; the next one arrives in two seconds.
    }
  }

  /// Sends one JSON command. Returns false if the helmet is not reachable.
  Future<bool> send(Map<String, dynamic> command) async {
    final characteristic = _command;
    if (!connected || characteristic == null) return false;
    try {
      await characteristic.write(utf8.encode(jsonEncode(command)), allowLongWrite: true);
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Gives the helmet the time, the hotspot login and the server address.
  Future<void> pushSettings() async {
    await send({'cmd': 'time', 'ts': DateTime.now().millisecondsSinceEpoch ~/ 1000});
    if (_store.hotspotSsid.isNotEmpty) {
      await send({'cmd': 'wifi', 'ssid': _store.hotspotSsid, 'pass': _store.hotspotPass});
    }
    if (_store.serverUrl.isNotEmpty) {
      await send({'cmd': 'server', 'url': _store.serverUrl});
    }
  }
}
