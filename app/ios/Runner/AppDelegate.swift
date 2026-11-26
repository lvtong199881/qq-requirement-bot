import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let result = super.application(application, didFinishLaunchingWithOptions: launchOptions)
    // 原生 toast 通道：Dart 侧 NativeToast.show/showLoading/hideLoading。
    // 隐式引擎由 FlutterAppDelegate 托管，启动完成后根 VC 就是 FlutterViewController，
    // 通道要在 super 返回之后再挂（那时引擎和 messenger 才存在）。
    if let controller = window?.rootViewController as? FlutterViewController {
      ToastHost.attach(messenger: controller.binaryMessenger)
    }
    return result
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
  }
}
