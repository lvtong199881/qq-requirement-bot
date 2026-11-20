// 服务端对象的只读视图。
//
// 所有 fromJson 都写容错解析：后端还会演进（字段可能加、可能暂时缺），
// 少一个字段不该让整个 App 崩掉，退化成 null 让界面自己决定怎么显示。

/// 阶段进度里的一格。
class Stage {
  const Stage({required this.name, required this.status});

  final String name;

  /// 已完成 / 进行中 / 未开始 / 等待确认 / 阻塞
  ///
  /// 后端有两种「等人」的措辞：阶段格子用「等待确认」，整体状态用「等你确认」。
  /// 两个都认，免得后端哪天统一文案时界面集体变灰。
  final String status;

  bool get done => status == '已完成';
  bool get active => status == '进行中' || status == '等待确认' || status == '等你确认';
  bool get blocked => status == '阻塞' || status == '卡住';

  factory Stage.fromJson(Map<String, dynamic> j) => Stage(
    name: (j['name'] ?? '').toString(),
    status: (j['status'] ?? '').toString(),
  );
}

/// 发起人 / 最后说话的人。
class Actor {
  const Actor({required this.userId, required this.nickname});

  final String? userId;
  final String? nickname;

  String get label => nickname?.isNotEmpty == true ? nickname! : (userId ?? '未知');

  factory Actor.fromJson(Map<String, dynamic> j) => Actor(
    userId: j['userId']?.toString(),
    nickname: j['nickname']?.toString(),
  );

  static Actor? maybe(Object? raw) =>
      raw is Map<String, dynamic> ? Actor.fromJson(raw) : null;
}

/// 账号。
class User {
  const User({
    required this.id,
    required this.username,
    required this.nickname,
    required this.role,
    required this.roleLabel,
    this.disabled = false,
  });

  final String id;
  final String username;
  final String nickname;

  /// admin / member。不要在前端硬编码这个判断来置灰按钮，
  /// 用 /api/auth/me 返回的 perms——权限规则将来只会改后端。
  final String role;
  final String roleLabel;
  final bool disabled;

  String get displayName => nickname.isNotEmpty ? nickname : username;
  bool get isAdmin => role == 'admin';

  factory User.fromJson(Map<String, dynamic> j) => User(
    id: (j['id'] ?? '').toString(),
    username: (j['username'] ?? '').toString(),
    nickname: (j['nickname'] ?? '').toString(),
    role: (j['role'] ?? 'member').toString(),
    roleLabel: (j['roleLabel'] ?? '').toString(),
    disabled: j['disabled'] == true,
  );
}

/// 「这个人能做什么」。后端算好给前端，前端只负责置灰。
class Perms {
  const Perms({
    this.startRequirement = false,
    this.confirm = false,
    this.command = false,
    this.comment = false,
    this.read = false,
  });

  final bool startRequirement;
  final bool confirm;
  final bool command;
  final bool comment;
  final bool read;

  factory Perms.fromJson(Map<String, dynamic> j) => Perms(
    startRequirement: j['startRequirement'] == true,
    confirm: j['confirm'] == true,
    command: j['command'] == true,
    comment: j['comment'] == true,
    read: j['read'] == true,
  );

  static const empty = Perms();
}

/// 一个群（后端叫 thread）。
///
/// 群是容器，需求（flow）跑在群里：群里不 @ 需求 bot 就只是聊天，
/// @ 一下才开始跑需求。所以群建好、还没提需求时 name（需求名）是 null，
/// 只有 groupName 和 pending。
class Thread {
  const Thread({
    required this.threadId,
    this.name,
    this.groupName,
    this.mode = 'chat',
    this.pending = false,
    this.reqId,
    this.stage,
    this.stageStatus,
    this.status,
    this.waitingLabel,
    this.turn = 0,
    this.initiator,
    this.lastActiveAt,
    this.running = false,
    this.needsMe = false,
    this.stages = const [],
    this.featureBranch,
    this.lastSeq = 0,
    this.canAct = false,
  });

  final String threadId;

  /// 需求名。由 agent 根据第一句话生成，群刚建好时是 null。
  final String? name;

  /// 群名。用户建群时自己起的，不随需求名变化。
  final String? groupName;

  /// chat（只是聊天）/ requirement（跑过需求；不 @ 需求 bot 仍然只是聊天）。
  /// 需求群不会退回 chat：那样「这句话该不该交给 agent」就说不清了。
  final String mode;

  /// 群里还没有需求。此时 stage 为 null，详情页要提示「@需求bot 说一句」。
  final bool pending;
  final String? reqId;

  /// 当前阶段名，如「需求澄清」
  final String? stage;

  /// 进行中 / 等你确认 / 卡住 / 已完成
  final String? stageStatus;
  final String? status;
  final String? waitingLabel;
  final int turn;
  final Actor? initiator;
  final int? lastActiveAt;

  /// 回合正在跑。App 可以据此显示转圈。
  final bool running;

  /// 需要我拍板。列表页靠它置顶 + 打角标。
  final bool needsMe;
  final List<Stage> stages;
  final String? featureBranch;

  /// 这个 thread 最新的消息 seq。列表页用来算未读数。
  final int lastSeq;

  /// 我能不能点通过/打回。普通成员能看到按钮，但这里会是 false。
  final bool canAct;

  /// 列表和标题用的名字：有需求名用需求名，还没提需求就退回群名。
  String get title {
    if (name?.isNotEmpty == true) return name!;
    if (groupName?.isNotEmpty == true) return groupName!;
    return '未命名群';
  }

  bool get finished => stageStatus == '已完成' || stage == '已交付';
  bool get blocked => stageStatus == '卡住';

  factory Thread.fromJson(Map<String, dynamic> j) => Thread(
    threadId: (j['threadId'] ?? '').toString(),
    name: j['name']?.toString(),
    groupName: j['groupName']?.toString(),
    mode: j['mode']?.toString() ?? 'chat',
    pending: j['pending'] == true,
    reqId: j['reqId']?.toString(),
    stage: j['stage']?.toString(),
    stageStatus: j['stageStatus']?.toString(),
    status: j['status']?.toString(),
    waitingLabel: j['waitingLabel']?.toString(),
    turn: (j['turn'] as num?)?.toInt() ?? 0,
    initiator: Actor.maybe(j['initiator']),
    lastActiveAt: (j['lastActiveAt'] as num?)?.toInt(),
    running: j['running'] == true,
    needsMe: j['needsMe'] == true,
    stages: (j['stages'] as List? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(Stage.fromJson)
        .toList(),
    featureBranch: j['featureBranch']?.toString(),
    lastSeq: (j['lastSeq'] as num?)?.toInt() ?? 0,
    canAct: j['canAct'] == true,
  );
}

/// 一条消息。seq 在同一 thread 内单调递增，App 靠它做增量拉取。
class Message {
  const Message({
    required this.seq,
    required this.at,
    required this.role,
    required this.kind,
    required this.payload,
  });

  final int seq;
  final int at;

  /// user / bot
  final String role;

  /// text / image / file / stage / decision
  final String kind;
  final Map<String, dynamic> payload;

  bool get isMine => role == 'user';

  /// 谁说的。老数据没有这两个字段，`userId` 为 null 时按「我」处理，
  /// 免得升级后历史消息全跑到左边去。
  String? get userId => payload['userId']?.toString();
  String? get nickname => payload['nickname']?.toString();

  /// 这条是不是 `myId` 说的。群里好几个人说话，只靠 role 分不出左右。
  bool isMineFor(String? myId) =>
      role == 'user' && (userId == null || myId == null || userId == myId);

  String get text => (payload['text'] ?? '').toString();
  String? get artifactUrl => payload['url']?.toString();
  String? get fileName => payload['name']?.toString();
  int? get fileSize => (payload['size'] as num?)?.toInt();

  factory Message.fromJson(Map<String, dynamic> j) => Message(
    seq: (j['seq'] as num?)?.toInt() ?? 0,
    at: (j['at'] as num?)?.toInt() ?? 0,
    role: (j['role'] ?? 'bot').toString(),
    kind: (j['kind'] ?? 'text').toString(),
    payload: (j['payload'] as Map?)?.cast<String, dynamic>() ?? const {},
  );
}
