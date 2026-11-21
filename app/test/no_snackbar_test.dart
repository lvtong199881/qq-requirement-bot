import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// 用户明确要求「禁止使用 SnackBar」。这条测试扫源码，防止以后有人
/// 图省事又写回去——单测很难覆盖「某处弹了个 SnackBar」，
/// 但扫字符串一定能覆盖。
void main() {
  test('lib 里没有任何 SnackBar / ScaffoldMessenger 用法', () {
    final dir = Directory('lib');
    expect(dir.existsSync(), isTrue, reason: '要在 app 目录下跑测试');

    final offenders = <String>[];
    for (final f in dir.listSync(recursive: true).whereType<File>()) {
      if (!f.path.endsWith('.dart')) continue;
      final text = f.readAsStringSync();
      for (final needle in ['SnackBar(', 'showSnackBar', 'ScaffoldMessenger']) {
        if (text.contains(needle)) {
          offenders.add('${f.path} → $needle');
        }
      }
    }

    expect(offenders, isEmpty, reason: '提示统一走 showToast：\n${offenders.join('\n')}');
  });
}
