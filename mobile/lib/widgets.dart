import 'package:flutter/material.dart';

import 'config.dart';
import 'services/helmet_link.dart';

/// A card on the black page. Dark by default; pass [AppColors.accent] or
/// [AppColors.attention] for a bright one, and its text and icons turn black.
class Panel extends StatelessWidget {
  const Panel({super.key, required this.child, this.color = AppColors.panel});

  final Widget child;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final bright = color == AppColors.accent || color == AppColors.attention;
    final foreground = bright ? AppColors.onAccent : AppColors.text;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(20),
        border: bright ? null : Border.all(color: const Color(0x1AFFFFFF)),
      ),
      child: IconTheme.merge(
        data: IconThemeData(color: foreground),
        child: DefaultTextStyle.merge(style: TextStyle(color: foreground), child: child),
      ),
    );
  }
}

/// One line of status: an icon, a label and a value.
class StatusLine extends StatelessWidget {
  const StatusLine({super.key, required this.icon, required this.label, required this.value});

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          children: [
            Icon(icon, size: 20, color: AppColors.accent),
            const SizedBox(width: 12),
            Expanded(child: Text(label, style: const TextStyle(color: AppColors.textMuted))),
            Text(value, style: const TextStyle(fontWeight: FontWeight.w600)),
          ],
        ),
      );
}

/// Shows whether the helmet camera is connected, and what it is doing.
/// White when it needs attention, lime while recording, dark otherwise.
class HelmetBadge extends StatelessWidget {
  const HelmetBadge({super.key, required this.helmet});

  final HelmetLink helmet;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: helmet,
        builder: (context, _) {
          final status = helmet.status;
          final recording = helmet.connected && status != null && status.recording;
          final String text;
          if (!helmet.connected) {
            text = 'Helmet camera not connected';
          } else if (recording) {
            text = 'Helmet camera recording';
          } else if (status != null && status.queued > 0) {
            text = 'Helmet camera ready, ${status.queued} waiting to upload';
          } else {
            text = 'Helmet camera ready';
          }
          return Panel(
            color: !helmet.connected
                ? AppColors.attention
                : recording
                    ? AppColors.accent
                    : AppColors.panel,
            child: Row(
              children: [
                Icon(helmet.connected ? Icons.videocam : Icons.videocam_off),
                const SizedBox(width: 12),
                Expanded(child: Text(text, style: const TextStyle(fontWeight: FontWeight.w600))),
              ],
            ),
          );
        },
      );
}
