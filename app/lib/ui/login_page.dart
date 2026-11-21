import 'package:flutter/material.dart';

import '../api/client.dart';
import '../state/auth.dart';
import 'server_setup_page.dart';
import 'theme.dart';
import 'widgets/feedback.dart';

/// 登录 / 注册。
///
/// 一个页面两个模式而不是两个路由：注册就是多两个字段，做完立刻登录，
/// 跳来跳去反而让人搞不清自己现在在哪一步。
class LoginPage extends StatefulWidget {
  const LoginPage({super.key, required this.auth});

  final AuthController auth;

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _username = TextEditingController(
    text: widget.auth.lastUsername ?? '',
  );
  final _password = TextEditingController();
  final _nickname = TextEditingController();

  bool _registering = false;
  bool _busy = false;
  bool _showPassword = false;
  String? _error;

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    _nickname.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_registering) {
        await widget.auth.register(
          username: _username.text.trim(),
          password: _password.text,
          nickname: _nickname.text.trim(),
        );
      } else {
        await widget.auth.login(
          username: _username.text.trim(),
          password: _password.text,
        );
      }
      // 成功后 stage 变 ready，根 Widget 自动换页
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(
              AppInset.form,
              AppSpace.xxl,
              AppInset.form,
              AppSpace.xxl,
            ),
            children: [
              Text(
                _registering ? '建个账号' : '欢迎回来',
                style: AppText.titleL.copyWith(color: theme.colorScheme.onSurface),
              ),
              const SizedBox(height: AppSpace.xs),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.auth.baseUrl.isEmpty ? '还没连服务器' : widget.auth.baseUrl,
                      style: AppText.bodyS.copyWith(color: theme.colorScheme.onSurfaceVariant),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  // 「换服务器」贴着地址放：这是它唯一有意义的上下文，
                  // 塞进 AppBar 右上角就变成了一个没人认得的小图标
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => Navigator.of(context).push(
                            MaterialPageRoute<void>(
                              builder: (_) => ServerSetupPage(
                                auth: widget.auth,
                                initialUrl: widget.auth.baseUrl,
                              ),
                            ),
                          ),
                    child: const Text('换服务器'),
                  ),
                ],
              ),
              const SizedBox(height: AppSpace.xl),

              TextFormField(
                controller: _username,
                enabled: !_busy,
                autocorrect: false,
                textInputAction: TextInputAction.next,
                style: AppText.body.copyWith(color: theme.colorScheme.onSurface),
                decoration: const InputDecoration(labelText: '用户名'),
                validator: (v) {
                  final s = (v ?? '').trim();
                  if (s.isEmpty) return '填个用户名';
                  if (s.length < 2) return '至少 2 个字';
                  if (s.length > 20) return '最多 20 个字';
                  return null;
                },
              ),
              const SizedBox(height: AppSpace.md),
              TextFormField(
                controller: _password,
                enabled: !_busy,
                obscureText: !_showPassword,
                style: AppText.body.copyWith(color: theme.colorScheme.onSurface),
                textInputAction: _registering ? TextInputAction.next : TextInputAction.done,
                decoration: InputDecoration(
                  labelText: '密码',
                  // 手机上打长密码最容易出错，给一眼看清的开关
                  suffixIcon: IconButton(
                    tooltip: _showPassword ? '隐藏密码' : '显示密码',
                    icon: Icon(_showPassword ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                    onPressed: () => setState(() => _showPassword = !_showPassword),
                  ),
                ),
                validator: (v) {
                  final s = v ?? '';
                  if (s.isEmpty) return '填个密码';
                  if (_registering && s.length < 6) return '至少 6 位';
                  return null;
                },
                onFieldSubmitted: (_) {
                  if (!_registering && !_busy) _submit();
                },
              ),
              if (_registering) ...[
                const SizedBox(height: AppSpace.md),
                TextFormField(
                  controller: _nickname,
                  enabled: !_busy,
                  style: AppText.body.copyWith(color: theme.colorScheme.onSurface),
                  decoration: const InputDecoration(
                    labelText: '昵称（选填）',
                    helperText: '列表和消息里显示这个名字',
                  ),
                ),
              ],

              if (_error != null) ...[
                const SizedBox(height: AppSpace.md),
                ErrorBox(message: _error!),
              ],

              const SizedBox(height: AppSpace.xl),
              FilledButton(
                onPressed: _busy ? null : _submit,
                child: _busy
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(_registering ? '注册并登录' : '登录'),
              ),
              const SizedBox(height: AppSpace.xs),
              TextButton(
                onPressed: _busy
                    ? null
                    : () => setState(() {
                        _registering = !_registering;
                        _error = null;
                      }),
                child: Text(_registering ? '我有账号，去登录' : '没有账号，注册一个'),
              ),

              if (_registering) ...[
                const SizedBox(height: AppSpace.lg),
                const HintRow(
                  text: '第一个注册的人会成为系统管理员。admin 才能建群、@ 机器人提需求、点通过/打回。',
                ),
              ],

              // 后端建了预设管理员（还没改过密码）就直接写出来。
              // 新装好的机器上，人拿到地址之后最容易卡在「用什么登录」这一步，
              // 让他去翻安装文档不如直接告诉他。
              if (!_registering && widget.auth.presetAdmin != null) ...[
                const SizedBox(height: AppSpace.lg),
                _PresetHint(
                  username: widget.auth.presetAdmin!,
                  password: widget.auth.presetPassword ?? '',
                  onFill: () => setState(() {
                    _username.text = widget.auth.presetAdmin!;
                    _password.text = widget.auth.presetPassword ?? '';
                    _error = null;
                  }),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// 预设账号提示。带一个「填入」按钮：知道密码和不用打密码是两回事，
/// 手机上打 6 位数字比点一下麻烦得多。
class _PresetHint extends StatelessWidget {
  const _PresetHint({
    required this.username,
    required this.password,
    required this.onFill,
  });

  final String username;
  final String password;
  final VoidCallback onFill;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(AppSpace.md),
      decoration: BoxDecoration(
        color: theme.colorScheme.secondaryContainer.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(AppRadius.medium),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.key_outlined, size: 20, color: theme.colorScheme.onSecondaryContainer),
              const SizedBox(width: AppSpace.xs),
              Text(
                '初始管理员账号',
                style: AppText.label.copyWith(color: theme.colorScheme.onSecondaryContainer),
              ),
            ],
          ),
          const SizedBox(height: AppSpace.xs),
          SelectableText(
            '$username / $password',
            style: AppText.body.copyWith(
              color: theme.colorScheme.onSecondaryContainer,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(height: AppSpace.xxs),
          Text(
            '登录后请在「账号管理」里改掉这个密码。',
            style: AppText.bodyS.copyWith(color: theme.colorScheme.onSecondaryContainer),
          ),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(onPressed: onFill, child: const Text('填入')),
          ),
        ],
      ),
    );
  }
}
