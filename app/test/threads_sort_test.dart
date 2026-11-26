import 'package:flutter_test/flutter_test.dart';
import 'package:network/network.dart';
import 'package:qqbot_app/state/threads.dart';

/// 列表排序是业务规则（等我拍板的排最前），留在 app 侧测。
void main() {
  group('ThreadListController.sortThreads', () {
    Thread t(String id, {bool needsMe = false, int? at}) =>
        Thread(threadId: id, needsMe: needsMe, lastActiveAt: at);

    test('等我拍板的永远排最前，即使更旧', () {
      final sorted = ThreadListController.sortThreads([
        t('new', at: 1000),
        t('old-but-mine', needsMe: true, at: 1),
      ]);
      expect(sorted.map((e) => e.threadId), ['old-but-mine', 'new']);
    });

    test('同一组内按最近活动倒序', () {
      final sorted = ThreadListController.sortThreads([
        t('a', at: 100),
        t('c', at: 300),
        t('b', at: 200),
      ]);
      expect(sorted.map((e) => e.threadId), ['c', 'b', 'a']);
    });

    test('lastActiveAt 为 null 时排在同组最后', () {
      final sorted = ThreadListController.sortThreads([
        t('nil'),
        t('has', at: 5),
      ]);
      expect(sorted.map((e) => e.threadId), ['has', 'nil']);
    });

    test('不修改传入的列表', () {
      final input = [t('a', at: 1), t('b', at: 2)];
      ThreadListController.sortThreads(input);
      expect(input.map((e) => e.threadId), ['a', 'b']);
    });
  });
}
