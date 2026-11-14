/// A delivery assigned to this driver, as returned by the server.
class Delivery {
  const Delivery({
    required this.id,
    required this.customerName,
    required this.address,
    required this.destLat,
    required this.destLon,
    required this.status,
    required this.attempts,
  });

  final String id;
  final String customerName;
  final String address;
  final double destLat;
  final double destLon;
  final String status;

  /// Recording attempts the server already knows about.
  final int attempts;

  factory Delivery.fromJson(Map<String, dynamic> json) => Delivery(
        id: json['id'] as String,
        customerName: json['customerName'] as String,
        address: json['address'] as String,
        destLat: (json['destLat'] as num).toDouble(),
        destLon: (json['destLon'] as num).toDouble(),
        status: json['status'] as String,
        attempts: (json['attempts'] as num?)?.toInt() ?? 0,
      );
}

/// The status the helmet broadcasts over Bluetooth every couple of seconds.
class HelmetStatus {
  const HelmetStatus({
    required this.recording,
    required this.recordingId,
    required this.chunks,
    required this.queued,
    required this.freeMb,
    required this.wifi,
    required this.flags,
    required this.error,
  });

  final bool recording;
  final String recordingId;
  final int chunks;

  /// Recordings waiting on the helmet for a connection.
  final int queued;
  final int freeMb;
  final bool wifi;
  final int flags;
  final String error;

  factory HelmetStatus.fromJson(Map<String, dynamic> json) => HelmetStatus(
        recording: json['st'] == 'rec',
        recordingId: (json['id'] as String?) ?? '',
        chunks: (json['ch'] as num?)?.toInt() ?? 0,
        queued: (json['q'] as num?)?.toInt() ?? 0,
        freeMb: (json['free'] as num?)?.toInt() ?? 0,
        wifi: json['wifi'] == 1,
        flags: (json['fl'] as num?)?.toInt() ?? 0,
        error: (json['err'] as String?) ?? '',
      );
}
