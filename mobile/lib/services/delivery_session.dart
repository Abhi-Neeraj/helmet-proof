import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';
import 'package:geolocator_android/geolocator_android.dart'
    show AndroidSettings, ForegroundNotificationConfig;

import '../config.dart';
import '../models.dart';
import 'api_client.dart';
import 'app_store.dart';
import 'helmet_link.dart';

enum SessionPhase { approaching, inZone, delivered, failed }

/// Runs one delivery from "on the way" to "delivered".
///
/// It watches the driver's position, tells the helmet to start recording at
/// 200 m, and only allows "Delivered" while the helmet confirms it is recording
/// this delivery. The recording id is always "<delivery id>-<attempt>".
class DeliverySession extends ChangeNotifier {
  DeliverySession({
    required this.delivery,
    required AppStore store,
    required ApiClient api,
    required HelmetLink helmet,
  })  : _store = store,
        _api = api,
        _helmet = helmet;

  final Delivery delivery;
  final AppStore _store;
  final ApiClient _api;
  final HelmetLink _helmet;

  StreamSubscription<Position>? _positions;
  Position? _position;
  Position? _lastSent;
  bool _startInFlight = false;
  bool _helmetWasConnected = false;
  bool _confirmedRecording = false;
  bool _disposed = false;

  SessionPhase phase = SessionPhase.approaching;
  double? distanceMetres;
  String? recordingId;

  /// A problem the driver should see, or null when all is well.
  String? problem;

  bool get finished => phase == SessionPhase.delivered || phase == SessionPhase.failed;

  /// True only while the helmet itself reports it is recording this delivery.
  bool get recordingConfirmed {
    final status = _helmet.status;
    return _helmet.connected &&
        status != null &&
        status.recording &&
        recordingId != null &&
        status.recordingId == recordingId;
  }

  /// The recording ended on its own (time limit or a fault) before delivery.
  bool get recordingEnded =>
      !finished && _confirmedRecording && _helmet.connected && !recordingConfirmed && !_startInFlight;

  /// Starts GPS tracking. Returns a message if location cannot be used.
  Future<String?> begin() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      return 'Location is switched off. Turn it on to start this delivery.';
    }
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
      return 'The app needs location permission to know when you are near the destination.';
    }

    _helmetWasConnected = _helmet.connected;
    _helmet.addListener(_onHelmetChanged);

    // From here on the customer's tracking link shows the rider.
    _api.sendEvent(delivery.id, 'delivery_started');

    // On Android the foreground notification keeps tracking alive when the
    // screen is off or the phone is in a pocket.
    final LocationSettings settings = defaultTargetPlatform == TargetPlatform.android
        ? AndroidSettings(
            accuracy: LocationAccuracy.high,
            distanceFilter: 5,
            intervalDuration: const Duration(seconds: 2),
            foregroundNotificationConfig: const ForegroundNotificationConfig(
              notificationTitle: 'Delivery in progress',
              notificationText: 'Tracking distance to the destination',
              enableWakeLock: true,
            ),
          )
        : const LocationSettings(accuracy: LocationAccuracy.high, distanceFilter: 5);

    _positions = Geolocator.getPositionStream(locationSettings: settings).listen(
      _onPosition,
      onError: (_) {
        problem = 'Location is not available right now.';
        _notify();
      },
    );
    return null;
  }

  /// Sends the position to the live map after moving 10 m, or every 20 s.
  void _shareLocation(Position position) {
    final last = _lastSent;
    if (last != null) {
      final elapsed = position.timestamp.difference(last.timestamp).inMilliseconds;
      final moved = Geolocator.distanceBetween(
          last.latitude, last.longitude, position.latitude, position.longitude);
      if (elapsed < 4000 || (moved < 10 && elapsed < 20000)) return;
    }
    _lastSent = position;
    _api.sendLocation(
      lat: position.latitude,
      lon: position.longitude,
      accuracy: position.accuracy,
      speed: position.speed,
      heading: position.heading,
      deliveryId: delivery.id,
    );
  }

  void _onPosition(Position position) {
    if (finished) return;
    _position = position;
    _shareLocation(position);
    distanceMetres = Geolocator.distanceBetween(
      position.latitude, position.longitude, delivery.destLat, delivery.destLon);

    if (phase == SessionPhase.approaching && distanceMetres! <= geofenceRadiusMetres) {
      phase = SessionPhase.inZone;
      _api.sendEvent(delivery.id, 'geofence_enter');
      _startRecording();
    } else if (phase == SessionPhase.inZone && distanceMetres! > geofenceExitMetres) {
      // Left without delivering. Coming back will start a fresh attempt.
      phase = SessionPhase.approaching;
      _helmet.send({'cmd': 'stop', 'after': 0});
    } else if (phase == SessionPhase.inZone && recordingId == null) {
      _startRecording(); // the helmet was not reachable on the first try
    }
    _notify();
  }

  void _onHelmetChanged() {
    if (finished) return;
    final nowConnected = _helmet.connected;
    if (_helmetWasConnected && !nowConnected && recordingId != null) {
      _api.sendEvent(delivery.id, 'camera_disconnected', recordingId: recordingId);
    } else if (!_helmetWasConnected && nowConnected && recordingId != null) {
      _api.sendEvent(delivery.id, 'camera_reconnected', recordingId: recordingId);
    }
    _helmetWasConnected = nowConnected;

    if (recordingConfirmed) {
      _confirmedRecording = true;
      problem = null;
    } else if (nowConnected && (_helmet.status?.error.isNotEmpty ?? false)) {
      problem = 'Helmet camera problem: ${_helmet.status!.error}';
    }
    // In the zone with a helmet that just came back and nothing started yet.
    if (phase == SessionPhase.inZone && recordingId == null && nowConnected) {
      _startRecording();
    }
    _notify();
  }

  /// Starts a new recording attempt on the helmet.
  Future<void> _startRecording({bool restart = false}) async {
    if (finished || _startInFlight) return;
    if (!_helmet.connected) {
      problem = 'Helmet camera is not connected. Check that it is switched on.';
      _notify();
      return;
    }
    _startInFlight = true;
    try {
      final attempt = [delivery.attempts, _store.attemptsFor(delivery.id)]
              .reduce((a, b) => a > b ? a : b) +
          1;
      final id = '${delivery.id}-$attempt';
      final sent = await _helmet.send({
        'cmd': 'start',
        'id': id,
        'ts': DateTime.now().millisecondsSinceEpoch ~/ 1000,
        'lat': _position?.latitude ?? delivery.destLat,
        'lon': _position?.longitude ?? delivery.destLon,
      });
      if (!sent) {
        problem = 'Could not reach the helmet camera. Trying again.';
        return;
      }
      await _store.setAttempts(delivery.id, attempt);
      recordingId = id;
      _confirmedRecording = false;
      problem = null;
      _api.sendEvent(delivery.id, restart ? 'recording_restarted' : 'recording_started',
          recordingId: id);
    } finally {
      _startInFlight = false;
      _notify();
    }
  }

  /// For when the recording stopped by itself and the handover has not happened yet.
  Future<void> restartRecording() => _startRecording(restart: true);

  /// Marks the delivery complete. Refused unless the helmet is recording it.
  Future<bool> markDelivered() async {
    if (finished) return true;
    if (!recordingConfirmed) {
      problem = 'The helmet camera is not recording, so this delivery cannot be completed yet.';
      _api.sendEvent(delivery.id, 'delivered_blocked', recordingId: recordingId);
      _notify();
      return false;
    }
    await _api.send('/api/driver/deliveries/${delivery.id}/complete', {
      'recordingId': recordingId,
      if (_position != null) 'lat': _position!.latitude,
      if (_position != null) 'lon': _position!.longitude,
    });
    await _helmet.send({'cmd': 'stop', 'after': stopDelaySeconds});
    phase = SessionPhase.delivered;
    await _stopTracking();
    _notify();
    return true;
  }

  /// Closes the delivery as not delivered, for example when nobody is home.
  Future<void> markFailed(String reason) async {
    if (finished) return;
    await _api.send('/api/driver/deliveries/${delivery.id}/fail', {
      'reason': reason,
      if (recordingId != null) 'recordingId': recordingId,
    });
    await _helmet.send({'cmd': 'stop', 'after': 3});
    phase = SessionPhase.failed;
    await _stopTracking();
    _notify();
  }

  Future<void> _stopTracking() async {
    await _positions?.cancel();
    _positions = null;
    _helmet.removeListener(_onHelmetChanged);
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _stopTracking();
    super.dispose();
  }
}
