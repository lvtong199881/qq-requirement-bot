/// 群消息列表「自动跟随最新」的规则。
///
/// 列表是 `reverse: true`：offset 0 就是最新那条（贴在输入框上方），
/// maxScrollExtent 是**最老**那条。所以判断「用户是不是本来就在底部」看的是
/// pixels 离 0 有多远，跟随的目标也是 0。
///
/// 之前这里写反了：条件是 `maxScrollExtent - pixels > 220`（等于「用户停在
/// 最老那头」才跟），跟的时候又 `jumpTo(maxScrollExtent)`（跳到最老那头）。
/// 结果是每来一条新消息（阶段播报、心跳都算）就把用户甩到屏幕最顶部，
/// 想点卡片还得自己往下翻半天。
library;

/// 离最新一条不超过这么远就认为「本来在底部」，可以自动跟随。
///
/// 取 220 是经验值：大约一屏半条消息的高度，手滑蹭一下不会脱离跟随，
/// 真往上翻历史了就不再打断。
const double followNewestThreshold = 220;

/// 当前偏移是不是「本来就在最新那头」。
bool shouldFollowNewest(double pixels) => pixels <= followNewestThreshold;
