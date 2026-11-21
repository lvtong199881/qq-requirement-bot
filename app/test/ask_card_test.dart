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

    expect(sentText, '弹窗时机？\n  A. 首次启动（推荐）');
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
    expect(sentText, '先做哪几块？\n  A. 登录\n  C. 我的\n  D. 再加个设置页');
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

  testWidgets('题号跟卡片一致：第 14 题写意见、第 15 题选项，两行都要在', (tester) async {
    String? sentText;
    List<MessageAnswer>? sentAnswers;
    final questions = [
      for (var i = 1; i <= 15; i++)
        AskQuestion(
          id: 'q$i',
          title: 'Q$i 第 $i 个问题？',
          kind: 'single',
          allowInput: true,
          inputLabel: '都不是？自己写',
          options: [opt('a', '甲'), opt('b', '乙')],
        ),
    ];

    await tester.pumpWidget(
      host(
        AskCardView(
          card: card(questions),
          canSubmit: true,
          onSubmit: (text, answers) async {
            sentText = text;
            sentAnswers = answers;
            return true;
          },
        ),
      ),
    );

    // 十五道题一屏放不下，先把测试窗口撑高，省得一路 scrollUntilVisible
    tester.view.physicalSize = const Size(1000, 4200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pump();

    // 第 14 题只写意见，第 15 题只点选项
    final fields = find.byType(TextField);
    await tester.enterText(fields.at(13), '照旧版来，先别动埋点');
    await tester.pump();
    await tester.tap(find.text('甲').last);
    await tester.pump();

    await tester.tap(find.widgetWithText(FilledButton, '提交'));
    await tester.pump();

    expect(
      sentText,
      'Q14 第 14 个问题？\n  C. 照旧版来，先别动埋点\n'
      'Q15 第 15 个问题？\n  A. 甲',
    );
    expect(sentAnswers?.map((a) => a.qid), ['q14', 'q15']);
    expect(sentAnswers?.first.input, '照旧版来，先别动埋点');
  });

  testWidgets('滑出视野再回来，写了一半的意见还在', (tester) async {
    final drafts = <String, AskDraft>{};
    final questions = [
      AskQuestion(
        id: 'q1',
        title: 'Q1 弹窗时机？',
        kind: 'single',
        allowInput: true,
        inputLabel: '自己写',
        options: [opt('a', '首次启动')],
      ),
    ];

    Widget build() => host(
      AskCardView(
        card: card(questions),
        canSubmit: true,
        drafts: drafts,
        onSubmit: (text, answers) async => true,
      ),
    );

    await tester.pumpWidget(build());
    await tester.enterText(find.byType(TextField), '每次升级后第一次');
    await tester.pump();

    // 模拟卡片被回收重建：换一棵树再挂回来，草稿在页面那一层
    await tester.pumpWidget(host(const SizedBox.shrink()));
    await tester.pumpWidget(build());

    expect(find.text('每次升级后第一次'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '提交'));
    await tester.pump();
    expect(find.text('已提交'), findsNothing); // 提交成功也不弹错误
  });
}
