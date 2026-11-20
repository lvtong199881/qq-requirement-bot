import 'package:intl/intl.dart';

/// 时间显示。
///
/// 列表页要的是「刚刚 / 3 分钟前」这种，能立刻判断新旧；
/// 详情页要的是具体时分。所以分成两个函数，不要一个函数配参数。
class Fmt {
  static final _hm = DateFormat('HH:mm');
  static final _mdhm = DateFormat('M月d日 HH:mm');
  static final _full = DateFormat('yyyy-MM-dd HH:mm');

  /// 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 昨天 14:20 / 3月2日
  static String relative(int? ms) {
    if (ms == null || ms <= 0) return '';
    final t = DateTime.fromMillisecondsSinceEpoch(ms);
    final now = DateTime.now();
    final diff = now.difference(t);
    if (diff.inSeconds < 60) return '刚刚';
    if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
    if (diff.inHours < 24 && now.day == t.day) return '${diff.inHours} 小时前';

    final yesterday = now.subtract(const Duration(days: 1));
    if (t.year == yesterday.year && t.month == yesterday.month && t.day == yesterday.day) {
      return '昨天 ${_hm.format(t)}';
    }
    if (t.year == now.year) return _mdhm.format(t);
    return _full.format(t);
  }

  /// 消息气泡上的时间：同一天只显示时分，跨天带上日期。
  static String messageTime(int ms) {
    if (ms <= 0) return '';
    final t = DateTime.fromMillisecondsSinceEpoch(ms);
    final now = DateTime.now();
    final sameDay = t.year == now.year && t.month == now.month && t.day == now.day;
    return sameDay ? _hm.format(t) : _mdhm.format(t);
  }

  /// 文件大小。产物动辄几 MB，要让人一眼看出该不该点。
  static String bytes(int? n) {
    if (n == null || n <= 0) return '';
    if (n < 1024) return '$n B';
    if (n < 1024 * 1024) return '${(n / 1024).toStringAsFixed(1)} KB';
    return '${(n / 1024 / 1024).toStringAsFixed(1)} MB';
  }
}
