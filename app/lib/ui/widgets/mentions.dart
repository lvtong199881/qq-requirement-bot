import 'package:flutter/material.dart';

/// `@名字` 的判定：@ 起头，后面跟一串不是空白、也不是常见标点的字符。
///
/// 不维护「已知名字表」——群里能 @ 谁由成员决定，前端再存一份名单只会两边
/// 不同步。输入框和气泡用同一个正则，免得「里面蓝、发出去不蓝」。
final _mentionPattern = RegExp(
  r'@[^\s@，。！？、；：,.!?;:()（）\[\]【】"“”‘’<>《》/\\|]+',
);

/// 把一段文字切成「普通段 + @段」。
List<TextSpan> mentionSpans(String text, TextStyle base, TextStyle highlight) {
  final spans = <TextSpan>[];
  var cursor = 0;
  for (final match in _mentionPattern.allMatches(text)) {
    if (match.start > cursor) {
      spans.add(TextSpan(text: text.substring(cursor, match.start), style: base));
    }
    spans.add(TextSpan(text: match.group(0), style: highlight));
    cursor = match.end;
  }
  if (cursor < text.length) {
    spans.add(TextSpan(text: text.substring(cursor), style: base));
  }
  return spans.isEmpty ? [TextSpan(text: text, style: base)] : spans;
}

/// 气泡正文用：@ 到的人和输入框里一个颜色。
TextSpan mentionRich(String text, TextStyle base, TextStyle highlight) =>
    TextSpan(children: mentionSpans(text, base, highlight));

/// 输入框控制器：边打边把 `@名字` 描成蓝色。
///
/// TextField 没有「部分文字着色」的参数，只能接管 buildTextSpan。
class MentionEditingController extends TextEditingController {
  MentionEditingController({super.text});

  /// 由页面在 build 时按当前主题塞进来，换深色模式也跟着变。
  TextStyle? highlight;

  @override
  TextSpan buildTextSpan({
    required BuildContext context,
    TextStyle? style,
    required bool withComposing,
  }) {
    final base = style ?? const TextStyle();
    // 中文输入法拼字过程中（还没上屏）交给默认实现：自己拆段会把拼音下划线
    // 弄丢，反而让人不知道打到哪了。
    if (withComposing && value.composing.isValid) {
      return super.buildTextSpan(
        context: context,
        style: style,
        withComposing: withComposing,
      );
    }
    if (!text.contains('@')) return TextSpan(style: base, text: text);
    final hi = highlight ?? base.copyWith(color: Theme.of(context).colorScheme.primary);
    return TextSpan(style: base, children: mentionSpans(text, base, hi));
  }
}
