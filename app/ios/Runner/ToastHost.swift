import Flutter
import UIKit

/// 原生 toast：Dart 侧 NativeToast 调过来，统一「上图标下文案」的竖排样式。
///
/// 为什么不用系统自带的 toast（如第三方或 UIAlertController）：
/// - UIAlertController 会挡住交互，不是 toast 语义；
/// - 自绘浮层（加在 keyWindow 上）才能和 Android 端拼出同一套样式。
///
/// 生命周期：普通 toast 约 2.2 秒自动淡出；loading 常驻，等 hideLoading。
/// 全部跑在主线程（Flutter method channel 本身就在主线程回调）。
class ToastHost: NSObject {
  static let channelName = "qqbot/toast"
  private static var loadingView: UIView?

  /// Dart 端注册入口，AppDelegate 里一行调用。
  static func attach(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: channelName, binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      switch call.method {
      case "show":
        let args = call.arguments as? [String: Any] ?? [:]
        let text = args["text"] as? String ?? ""
        let type = args["type"] as? String
        show(text: text, type: type)
        result(nil)
      case "showLoading":
        let args = call.arguments as? [String: Any] ?? [:]
        let text = args["text"] as? String ?? ""
        showLoading(text: text)
        result(nil)
      case "hideLoading":
        hideLoading()
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  // MARK: - 对外行为

  /// 会自动消失的 toast；type 为 nil 时是纯文本样式。
  static func show(text: String, type: String?) {
    dismissLoadingIfNeeded()
    showToastView(makeView(text: text, type: type, loading: false), autoDismiss: true)
  }

  /// 常驻 loading，必须 hideLoading 收。
  static func showLoading(text: String) {
    dismissLoadingIfNeeded()
    let view = makeView(text: text, type: nil, loading: true)
    showToastView(view, autoDismiss: false)
    loadingView = view
  }

  static func hideLoading() {
    dismissLoadingIfNeeded()
  }

  // MARK: - 内部实现

  private static func dismissLoadingIfNeeded() {
    if let v = loadingView {
      UIView.animate(withDuration: 0.18, animations: { v.alpha = 0 }) { _ in
        v.removeFromSuperview()
      }
      loadingView = nil
    }
  }

  private static func showToastView(_ view: UIView, autoDismiss: Bool) {
    guard let window = UIApplication.shared.keyWindow ?? UIApplication.shared.windows.first(where: \.isKey) else {
      return
    }
    window.addSubview(view)
    // 居中：和 Android 端系统 toast 的默认位置一个观感
    view.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      view.centerXAnchor.constraint(equalTo: window.centerXAnchor),
      view.centerYAnchor.constraint(equalTo: window.centerYAnchor),
    ])
    view.alpha = 0
    UIView.animate(withDuration: 0.18) { view.alpha = 1 }
    guard autoDismiss else { return }
    // 2.2 秒后淡出
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) {
      guard view.superview != nil else { return }
      UIView.animate(withDuration: 0.25, animations: { view.alpha = 0 }) { _ in
        view.removeFromSuperview()
      }
    }
  }

  /// 竖排容器：半透明圆角黑底，上图标（或转圈）下文案。
  private static func makeView(text: String, type: String?, loading: Bool) -> UIView {
    let container = UIView()
    container.backgroundColor = UIColor(white: 0.13, alpha: 0.92)
    container.layer.cornerRadius = 12
    container.layer.masksToBounds = true

    let stack = UIStackView()
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 8
    stack.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(stack)

    // 第一行：图标（或 loading 转圈）
    if loading {
      let indicator = UIActivityIndicatorView(style: .large)
      indicator.color = .white
      indicator.startAnimating()
      stack.addArrangedSubview(indicator)
    } else if let symbol = symbolName(for: type) {
      // SF Symbols 三态图标：info.circle / exclamationmark.triangle.fill / xmark.octagon.fill
      let config = UIImage.SymbolConfiguration(pointSize: 30, weight: .medium)
      let icon = UIImageView(image: UIImage(systemName: symbol, withConfiguration: config))
      icon.tintColor = .white
      icon.contentMode = .scaleAspectFit
      icon.widthAnchor.constraint(equalToConstant: 30).isActive = true
      icon.heightAnchor.constraint(equalToConstant: 30).isActive = true
      stack.addArrangedSubview(icon)
    }

    // 第二行：文案
    let label = UILabel()
    label.text = text
    label.textColor = .white
    label.font = .systemFont(ofSize: 15)
    label.numberOfLines = 4
    label.textAlignment = .center
    stack.addArrangedSubview(label)

    // 约束：内容撑开，外边距 16，宽度上限避免长文案拉成一条横幅
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 16),
      stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -16),
      stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16),
      stack.widthAnchor.constraint(lessThanOrEqualToConstant: 240),
    ])
    return container
  }

  private static func symbolName(for type: String?) -> String? {
    switch type {
    case "info": return "info.circle"
    case "warning": return "exclamationmark.triangle.fill"
    case "error": return "xmark.octagon.fill"
    default: return nil
    }
  }
}
