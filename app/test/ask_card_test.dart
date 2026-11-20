import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qqbot_app/api/models.dart';
import 'package:qqbot_app/ui/theme.dart';
import 'package:qqbot_app/ui/widgets/ask_card.dart';

/// 提问卡片：勾选 → 提交 → 自动插一句什么话。
///
/// 这段文案是给人看的，也是 agent 下一轮的依据，所以逐字断言：
/// 「1. 问题 A. 选项」这种格式是用户明确要求的样子。
void main() {
  Widget host(Widget child) => MaterialApp(
    theme: buildTheme(Brightness.light),
    home: Scaffold(body: SingleChildScrollView(child: child)),
  );

  AskOption opt(String id, String label) => AskOption(id: id, label: label);

  AskCard card(List<AskQuestion> qs) =>
      AskCard(title: '需要你拍板', submitLabel: '提交', questions: qs);

  testWidgets('单选题：勾一个再提交，文本和结构化答案都对', (tester) async {
    String? sentText;
    List<MessageAnswer>? sentAnswers;
    await tester.pumpWidget(
      host(
        AskCardView(
          card: card([
            AskQuestion(
              id: 'q1',
              title: '弹窗时机？',
              kind: 'single',
              allowInput: true,
              inputLabel: '都不是？自己写',
              options: [opt('a', '首次启动（推荐）'), opt('b', '每次启动')],
            ),
          ]),
          canSubmit: true,
          onSubmit: (text, answers) async {
            sentText = text;
            sentAnswers = answers;
            return true;
          },
        ),
      ),
    );

    // 一道题都没答时提交按钮是灰的：点不动
    final submit = find.widgetWithText(FilledButton, '提交');
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);

    await tester.tap(find.text('首次启动（推荐）'));
    await tester.pump();

    expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);
    await tester.tap(submit);
    await tester.pump();

    expect(sentText, '1. 弹窗时机？ A. 首次启动（推荐）');
    expect(sentAnswers?.length, 1);
    expect(sentAnswers?.first.qid, 'q1');
    expect(sentAnswers?.first.optionIds, ['a']);
  });

  testWidgets('多选题：选两个 + 自己写一句，都带上', (tester) async {
    String? sentText;
    await tester.pumpWidget(
      host(
        AskCardView(
          card: card([
            AskQuestion(
              id: 'q1',
              title: '先做哪几块？',
              kind: 'multi',
              allowInput: true,
              inputLabel: '还有别的就写这儿',
              options: [opt('a', '登录'), opt('b', '首页'), opt('c', '我的')],
            ),
          ]),
          canSubmit: true,
          onSubmit: (text, answers) async {
            sentText = text;
            return true;
          },
        ),
      ),
    );

    await tester.tap(find.text('登录'));
    await tester.pump();
    await tester.tap(find.text('我的'));
    await tester.pump();
    await tester.enterText(find.byType(TextField), '再加个设置页');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '提交'));
    await tester.pump();

    // 自己写的那句排在最后一个选项的位置：D
    expect(sentText, contains('1. 先做哪几块？ A. 登录  C. 我的  D. 再加个设置页'));
  });

  testWidgets('通过/打回：选打回必须能写理由', (tester) async {
    String? sentText;
    await tester.pumpWidget(
      host(
        AskCardView(
          card: card([
            AskQuestion(
              id: 'confirm',
              title: '本轮是否通过？',
              kind: 'single',
              allowInput: true,
              inputLabel: '打回理由（选「打回」时填）',
              options: [opt('approve', '通过'), opt('reject', '打回')],
            ),
          ]),
          canSubmit: true,
          onSubmit: (text, answers) async {
            sentText = text;
            return true;
          },
        ),
      ),
    );

    await tester.tap(find.text('打回'));
    await tester.pump();
    await tester.enterText(find.byType(TextField), '按钮颜色不对');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '提交'));
    await tester.pump();

    expect(sentText, '打回：按钮颜色不对');
  });

  testWidgets('通过就发两个字', (tester) async {
    String? sentText;
    await tester.pumpWidget(
      host(
        AskCardView(
          card: card([
            AskQuestion(
              id: 'confirm',
              title: '本轮是否通过？',
              kind: 'single',
              allowInput: true,
              inputLabel: '打回理由（选「打回」时填）',
              options: [opt('approve', '通过'), opt('reject', '打回')],
            ),
          ]),
          canSubmit: true,
          onSubmit: (text, answers) async {
            sentText = text;
            return true;
          },
        ),
      ),
    );

    await tester.tap(find.text('通过'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '提交'));
    await tester.pump();

    expect(sentText, '通过');
  });

  testWidgets('已经提交过的卡片只读', (tester) async {
    await tester.pumpWidget(
      host(
        AskCardView(
          card: card([
            AskQuestion(
              id: 'q1',
              title: '弹窗时机？',
              kind: 'single',
              allowInput: false,
              inputLabel: '',
              options: [opt('a', '首次启动'), opt('b', '每次启动')],
            ),
          ]),
          canSubmit: true,
          answered: const [
            MessageAnswer(qid: 'q1', optionIds: ['b'], input: ''),
          ],
          onSubmit: (text, answers) async => true,
        ),
      ),
    );

    expect(find.text('已提交'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '提交'), findsNothing);
  });

  testWidgets('没有确认权限时只显示不让提交', (tester) async {
    await tester.pumpWidget(
      host(
        AskCardView(
          card: card([
            AskQuestion(
              id: 'confirm',
              title: '本轮是否通过？',
              kind: 'single',
              allowInput: true,
              inputLabel: '打回理由',
              options: [opt('approve', '通过'), opt('reject', '打回')],
            ),
          ]),
          canSubmit: false,
          onSubmit: (text, answers) async => true,
        ),
      ),
    );

    expect(find.widgetWithText(FilledButton, '提交'), findsNothing);
    expect(find.textContaining('只有系统管理员能操作'), findsOneWidget);
  });
}
