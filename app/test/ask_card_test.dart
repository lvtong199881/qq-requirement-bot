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
    // 卡片一次只显示一题，直接跳到第 14 题（翻十四次和用户实际做的事一样，只是慢）
    final state = AskCardState()..step = 13;

    Widget buildAt(int step) => host(
      AskCardView(
        card: card(questions),
        canSubmit: true,
        state: state,
        onSubmit: (text, answers) async {
          sentText = text;
          sentAnswers = answers;
          return true;
        },
      ),
    );

    // 全答才能提交：1–13 题先各点一个选项
    for (var i = 0; i < 13; i++) {
      state.step = i;
      await tester.pumpWidget(buildAt(i));
      await tester.tap(find.text('甲'));
      await tester.pump();
    }

    // 第 14 题只写意见
    state.step = 13;
    await tester.pumpWidget(buildAt(13));
    await tester.enterText(find.byType(TextField), '照旧版来，先别动埋点');
    await tester.pump();

    // 第 15 题只点选项
    state.step = 14;
    await tester.pumpWidget(buildAt(14));
    await tester.tap(find.text('甲'));
    await tester.pump();

    await tester.tap(find.widgetWithText(FilledButton, '提交'));
    await tester.pump();

    // 全答了：结构化答案 15 条，逐题都有
    expect(sentAnswers?.length, 15);
    expect(sentAnswers?.first.qid, 'q1');
    // 题干自带 Q14 不重复编号；自己写的话占 C 位（两选项之后）
    expect(sentText, contains('Q14 第 14 个问题？\n  C. 照旧版来，先别动埋点'));
    expect(sentText, contains('Q15 第 15 个问题？\n  A. 甲'));
    expect(sentAnswers?[13].input, '照旧版来，先别动埋点');
  });

  testWidgets('滑出视野再回来，写了一半的意见还在', (tester) async {
    final state = AskCardState();
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
        state: state,
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

  testWidgets('一次一题：单选自动下一题，多选不跳，最后一题才能提交', (tester) async {
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
              allowInput: false,
              inputLabel: '',
              options: [opt('a', '首次启动'), opt('b', '每次启动')],
            ),
            AskQuestion(
              id: 'q2',
              title: '先做哪几块？',
              kind: 'multi',
              allowInput: false,
              inputLabel: '',
              options: [opt('a', '登录'), opt('b', '我的')],
            ),
            AskQuestion(
              id: 'q3',
              title: '什么时候上线？',
              kind: 'single',
              allowInput: false,
              inputLabel: '',
              options: [opt('a', '这周'), opt('b', '下周')],
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

    final submit = find.widgetWithText(FilledButton, '提交');
    expect(find.text('1/3'), findsOneWidget);
    // 不在最后一题，提交点不动
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);

    // 单选：选完自动到第 2 题
    await tester.tap(find.text('首次启动'));
    await tester.pump();
    expect(find.text('2/3'), findsOneWidget);

    // 多选：选两个都停在原地
    await tester.tap(find.text('登录'));
    await tester.pump();
    expect(find.text('2/3'), findsOneWidget);
    await tester.tap(find.text('我的'));
    await tester.pump();
    expect(find.text('2/3'), findsOneWidget);
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);

    // 跳过第 2 题 → 第 3 题：跳过只是翻页，没答的题还压着提交
    await tester.tap(find.text('跳过'));
    await tester.pump();
    expect(find.text('3/3'), findsOneWidget);
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);

    // 回到第 2 题：跳过前已经答过（登录+我的都在草稿里），不用再点——
    // 再点一次会把选项 toggle 掉（多选可取消）
    await tester.tap(find.byTooltip('上一题'));
    await tester.pump();
    await tester.tap(find.byTooltip('下一题'));
    await tester.pump();
    // 第 3 题也没答，提交还是灰的
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await tester.tap(find.text('这周'));
    await tester.pump();
    expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);

    // 上一题还能回去看
    await tester.tap(find.byTooltip('上一题'));
    await tester.pump();
    expect(find.text('2/3'), findsOneWidget);

    await tester.tap(find.byTooltip('下一题'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '提交'));
    await tester.pump();

    expect(
      sentText,
      '1. 弹窗时机？\n  A. 首次启动\n'
      '2. 先做哪几块？\n  A. 登录\n  B. 我的\n'
      '3. 什么时候上线？\n  A. 这周',
    );
    expect(sentAnswers?.map((a) => a.qid), ['q1', 'q2', 'q3']);
  });
}
