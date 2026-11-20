import 'package:flutter/material.dart';

import '../api/client.dart';
import '../state/auth.dart';

/// 配置服务器地址。
///
/// 这是整个 App 唯一的「安装向导」步骤：自建服务没有域名可写死，
/// 用户必须自己填。所以做得尽量宽容——不带协议也认，末尾斜杠也认。
class ServerSetupPage extends StatefulWidget {
  const ServerSetupPage({super.key, required this.auth, this.initialUrl});

  final AuthController auth;
  final String? initialUrl;

  @override
  State<ServerSetupPage> createState() => _ServerSetupPageState();
}

class _ServerSetupPageState extends State<ServerSetupPage> {
  late final TextEditingController _url = TextEditingController(
    text: widget.initialUrl ?? '',
  );
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.auth.setServer(_url.text);
      // setServer 成功后 stage 变成 needLogin，根 Widget 会自动换页
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
      appBar: AppBar(title: const Text('连接服务器')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Icon(Icons.dns_outlined, size: 56, color: theme.colorScheme.primary),
            const SizedBox(height: 16),
            Text('先填一下后端地址', style: theme.textTheme.titleLarge),
            const SizedBox(height: 8),
            Text(
              '就是跑着 qq-requirement-bot 的那台机器。'
              '局域网可以直接写 IP，公网就填 Cloudflare Tunnel 给你的域名。',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 24),
            TextField(
              controller: _url,
              autofocus: true,
              enabled: !_busy,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: '服务器地址',
                hintText: 'http://192.168.1.10:7881',
              ),
              onSubmitted: (_) => _busy ? null : _submit(),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              _ErrorBox(message: _error!),
            ],
            const SizedBox(height: 20),
            FilledButton(
              onPressed: _busy ? null : _submit,
              child: _busy
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('连接'),
            ),
            const SizedBox(height: 24),
            _Hint(
              title: '不填协议也行',
              body: '只写 192.168.1.10:7881 会按 http 处理。自建服务通常没配证书，'
                  '所以默认不猜 https。',
            ),
            const SizedBox(height: 12),
            _Hint(
              title: '后端要开启 App API',
              body: 'bot.config.json 里设置 api.enabled = true，'
                  '默认端口 7881。启动日志里会打印实际地址。',
            ),
          ],
        ),
      ),
    );
  }
}

class _Hint extends StatelessWidget {
  const _Hint({required this.title, required this.body});

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.4),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: theme.textTheme.labelLarge),
          const SizedBox(height: 4),
          Text(
            body,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              height: 1.5,
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorBox extends StatelessWidget {
  const _ErrorBox({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.errorContainer,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline, size: 18, color: scheme.onErrorContainer),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: scheme.onErrorContainer, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }
}
