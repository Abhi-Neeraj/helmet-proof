import 'package:flutter/material.dart';

import '../config.dart';
import '../main.dart';
import '../models.dart';
import '../services/delivery_session.dart';
import '../widgets.dart';

/// The screen the driver keeps open while riding to one delivery.
class ActiveDeliveryScreen extends StatefulWidget {
  const ActiveDeliveryScreen({super.key, required this.services, required this.delivery});

  final Services services;
  final Delivery delivery;

  @override
  State<ActiveDeliveryScreen> createState() => _ActiveDeliveryScreenState();
}

class _ActiveDeliveryScreenState extends State<ActiveDeliveryScreen> {
  late final DeliverySession _session;
  String? _locationProblem;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final services = widget.services;
    _session = DeliverySession(
      delivery: widget.delivery,
      store: services.store,
      api: services.api,
      helmet: services.helmet,
    );
    _session.begin().then((problem) {
      if (mounted) setState(() => _locationProblem = problem);
    });
  }

  @override
  void dispose() {
    _session.dispose();
    super.dispose();
  }

  Future<void> _delivered() async {
    setState(() => _busy = true);
    await _session.markDelivered();
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _couldNotDeliver() async {
    final controller = TextEditingController();
    final reason = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppColors.panel,
        title: const Text('Could not deliver'),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLength: 200,
          decoration: const InputDecoration(labelText: 'What happened'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('Confirm'),
          ),
        ],
      ),
    );
    if (reason == null) return;
    setState(() => _busy = true);
    await _session.markFailed(reason.isEmpty ? 'No reason given' : reason);
    if (mounted) setState(() => _busy = false);
  }

  String _distanceText(double? metres) {
    if (metres == null) return 'Finding your location';
    if (metres >= 1000) return '${(metres / 1000).toStringAsFixed(1)} km away';
    return '${metres.round()} m away';
  }

  @override
  Widget build(BuildContext context) {
    final delivery = widget.delivery;
    return Scaffold(
      appBar: AppBar(title: Text('Delivery ${delivery.id}')),
      body: ListenableBuilder(
        listenable: Listenable.merge([_session, widget.services.helmet]),
        builder: (context, _) {
          final session = _session;
          final problem = _locationProblem ?? session.problem;
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Panel(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(delivery.customerName,
                        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 4),
                    Text(delivery.address, style: const TextStyle(color: AppColors.textMuted)),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              if (session.finished)
                _FinishedPanel(delivered: session.phase == SessionPhase.delivered)
              else ...[
                Panel(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(_distanceText(session.distanceMetres),
                          style: const TextStyle(fontSize: 32, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 4),
                      Text(
                        session.phase == SessionPhase.inZone
                            ? 'You are inside the ${geofenceRadiusMetres.round()} m zone.'
                            : 'Recording starts by itself at ${geofenceRadiusMetres.round()} m.',
                        style: const TextStyle(color: AppColors.textMuted),
                      ),
                      const Divider(height: 24),
                      StatusLine(
                        icon: Icons.videocam,
                        label: 'Helmet camera',
                        value: widget.services.helmet.connected ? 'Connected' : 'Not connected',
                      ),
                      StatusLine(
                        icon: Icons.fiber_manual_record,
                        label: 'Recording',
                        value: session.recordingConfirmed
                            ? 'On'
                            : session.recordingEnded
                                ? 'Stopped'
                                : 'Off',
                      ),
                      if (session.recordingId != null)
                        StatusLine(
                          icon: Icons.tag,
                          label: 'Recording ID',
                          value: session.recordingId!,
                        ),
                    ],
                  ),
                ),
                if (problem != null) ...[
                  const SizedBox(height: 12),
                  Panel(
                    color: AppColors.attention,
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(Icons.warning_amber),
                        const SizedBox(width: 12),
                        Expanded(child: Text(problem)),
                      ],
                    ),
                  ),
                ],
                const SizedBox(height: 16),
                if (session.recordingEnded) ...[
                  FilledButton.icon(
                    onPressed: session.restartRecording,
                    icon: const Icon(Icons.restart_alt),
                    label: const Text('Restart recording'),
                  ),
                  const SizedBox(height: 12),
                ],
                FilledButton.icon(
                  // Locked until the helmet itself confirms it is recording this delivery.
                  onPressed: session.recordingConfirmed && !_busy ? _delivered : null,
                  icon: const Icon(Icons.check_circle),
                  label: const Text('Delivered'),
                ),
                if (!session.recordingConfirmed)
                  const Padding(
                    padding: EdgeInsets.only(top: 8),
                    child: Text(
                      'Delivered unlocks once the helmet camera is recording.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: AppColors.textMuted),
                    ),
                  ),
                const SizedBox(height: 12),
                OutlinedButton(
                  onPressed: _busy ? null : _couldNotDeliver,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: AppColors.text,
                    minimumSize: const Size.fromHeight(48),
                    side: const BorderSide(color: AppColors.textMuted),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                  child: const Text('Could not deliver'),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _FinishedPanel extends StatelessWidget {
  const _FinishedPanel({required this.delivered});

  final bool delivered;

  @override
  Widget build(BuildContext context) => Panel(
        child: Column(
          children: [
            Icon(delivered ? Icons.check_circle : Icons.cancel, size: 48, color: AppColors.text),
            const SizedBox(height: 12),
            Text(delivered ? 'Delivered' : 'Marked as not delivered',
                style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            const Text(
              'The video uploads by itself when the helmet has a connection. Keep your hotspot on.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColors.textMuted),
            ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Back to my deliveries'),
            ),
          ],
        ),
      );
}
