# 安卓客户端

`android-client/` 是一个基于 **Capacitor 8** 的工程，把独立维护的 `android-client/www/` Web 壳资源打包成安卓 App。
包名：`local.fanhao.library`，应用名：`个人视频资料库`。

## 套图浏览

套图顶部分类与番号页共用文字标签、选中下划线和排序/搜索按钮样式。分类内直接展开真实小合集，默认与网页 `/photo/collections` 一样按期数最多排序（同数量再比较容量和名称）；不再重复显示大类目录、“按合集 / 全部套图”栏或索引维护信息。右上角排序支持最近更新、期数最多、容量最大和名称排序。进入小合集后显示其套图，返回时保留分类；搜索仍使用套图结果。索引维护保留在电脑后台。

合集使用固定 3:4 封面框，横图、长图、缓存命中与滚动懒加载都不会改变卡片尺寸；缺失封面保留同尺寸占位。仅合集封面裁切，进入合集后的套图瀑布流仍按原图比例显示。

合集内的系统返回与“返回分类”共用模块返回处理：有应用返回栈时还原分类、排序和滚动位置；冷启动或恢复到合集、没有返回栈时补回所属分类。模块可通过 `isRootView(view, params)` 进一步限定 `rootViews`，避免把共用 `channel` 路由的合集误判为顶层页面。只有真正的分类首页才将系统返回交还 Android。

## 漫画任务与阅读进度

漫画书库仅在有进行中任务、失败、连接问题或短暂完成提示时展开任务区；完成提示到期后，空任务区会整体收起。历史记录通过书库顶部的记录按钮主动查看，打开时重新读取最新状态；收起记录不清理任务或漫画文件。失败任务排在完成历史之前，无正在进行的任务时，连接失败仍保留重试入口。手动查看记录或重试连接发现任务刚完成时，也会刷新书库数据。

添加漫画只更新书库中的表单和任务状态，不会因启动响应、轮询或失败而重绘其他页面。首次生成可访问书页及任务结束时才刷新当前书库。成功后清空并收起添加表单；失败保留链接供修改或重试，采集中也可手动收起表单而不取消任务。每次新增/重试有独立请求代次，上一任务的迟到响应不会覆盖下一任务；重新输入的新草稿不会被已完成的历史记录清空。

阅读位置按漫画保存。滚动时合并写入，返回目录、切换模块、渲染被取消或应用进入后台时立即补存，避免丢失尚未写入的进度；第一张图片也会建立阅读记录。

书页“继续阅读”和阅读页“回到第 N 张”会先扩展显示范围，再定位到目标。手机缓存被较新的章节数据替换时保留当前阅读锚点；慢图加载导致布局变化时短暂校正位置，用户开始触摸、滚轮或键盘滚动后立即停止校正。继续显示图片只追加新页面，不重新读取或重绘整章。

## 目录结构

```
android-client/
├── capacitor.config.json   # Capacitor 配置（包名、本地 origin、混合内容）
├── package.json
├── version.json             # 受 Git 审阅的默认构建身份与发布最低高水位
├── build-debug.ps1         # 构建 debug APK（可选连真机安装）
├── publish-debug-update.ps1# 构建并把 APK 发布到更新通道目录
├── install-published-debug.ps1 # 校验并安装 latest.json 当前发布 APK
├── www/                    # Android 专用 Web 壳；仅 games/ 从根目录 public/games 同步
└── android/                # 原生安卓工程（Gradle）
```

## 启动与离线恢复

启动先读取本机模块目录缓存（没有缓存时使用 APK 内置目录），初始化对应页面和底部导航；服务器模块目录、总资料库与汇总数据在后台更新，不再串行阻塞整个界面。刷新后的模块目录供下次启动使用，避免重建正在使用的阅读器或本机工具。

总资料库只驱动番号人物页和旧首页的汇总内容；漫画、套图、欧美人物、作品详情、短视频等页面使用各自的数据请求。后台总库加载结束不会重绘这些独立页面。无缓存连接失败时，人物页保留导航并提供“重新连接 / 检查地址”，不会强制跳回首页或弹出设置；已有缓存时继续显示缓存。切换服务后总库请求按来源和请求代次隔离，旧响应不会写入新服务的数据或覆盖当前页面。

设置中的“连接”和快捷地址均会实际重连，即使地址没有变化。支持不带协议的 `主机:端口` 输入；连接期间禁用同地址重复操作，但仍可输入或选择其他地址。明确重连会重新加载当前的服务器内容页，不重建“我的”中的本机工具，后台完成也不会再次打断其他页面。响应必须包含有效的人物列表与资料库统计，否则显示连接失败且不写入缓存；暂时断线时保留已有磁盘缓存或内存中的已加载资料库。

## 请求与页面生命周期

JSON 请求的超时和取消覆盖响应头与正文读取全过程；收到响应头不会提前停止计时。切换页面引发的主动取消保留 `AbortError`，不会误报成连接超时，HTTP 错误状态与重试字段保持原有契约。

异步页面只有在路由、参数和本次渲染仍有效时才能恢复滚动。触摸、鼠标滚轮或键盘滚动会取消尚未完成的恢复，旧请求结束后不会重新接管用户已经调整的位置。输入框编辑与已处理的按键不触发取消。

音乐歌曲、歌手、专辑及智能歌单分页会固定请求的服务、筛选和原列表。切换搜索、分类、范围、服务或离开音乐页时取消旧分页；迟到响应和旧请求的收尾都不能把数据追加到新列表或清除新请求的加载状态。

短视频兼容播放的每次重试都实时检查前后台、当前播放器、遮挡层与用户播放意图；退到后台、手动暂停或打开作者/评论层后不会因旧重试自动播放。缓冲期间也可以暂停，播放器释放或重新绑定时取消对应重试。关闭搜索或评论层时只恢复原来正在播放或等待缓冲的同一视频；已暂停或播放结束的视频不会自动恢复。播放结束后点击画面仍可从头重播。

从作者页返回短视频流时保留同一作品的播放位置和播放意图，包括图集视频片段与配乐；手动暂停和播放结束不会被播放器重建或迟到的结束回调改成自动播放、重播或翻页。恢复只作用于对应作品及片段，后续点击、拖动进度和切换内容由用户的新操作决定；正常打开作者作品或显式重试仍沿用原有播放策略。

长视频进度使用独立的串行发送器，慢请求期间只保留最新待发快照，不积压中间位置。退到后台时停止定时上报并补存，返回前台时恢复单条定时任务；退出时允许已接收的最后快照发送完毕，不阻塞界面，也不让发送器持有已销毁的播放器页面。兼容流进度仍换算到原视频时间轴。上报为尽力而为，不保证断网或系统杀进程后的持久投递。

定向回归入口：

```powershell
npm run verify:android-client       # JSON 超时/取消、滚动恢复、音乐分页、下载权限、小说阅读/事务
npm run verify:short-video-client   # 短视频协议、原生生命周期与重试
npm run verify:video-playback       # 视频协议、原生长视频进度与生命周期
npm run verify:browser-behavior     # 完整 Web/Android 壳交互回归
```

这些回归使用隔离数据与模拟原生依赖，不连接手机或修改真实媒体库；Android 系统与解码器的实际行为仍需真机验证。

## 小说阅读切换与进度保存

本地书、离线缓存和远程章节均绑定当前阅读会话。切换书籍、章节或服务后，旧读取、错误、目录结果和滚动恢复回调不能覆盖新页面。壳在改动页面布局前补存旧页面进度；加载占位不写入零进度。用户开始触摸、滚轮或阅读导航按键操作时取消尚未完成的恢复；缓存刷新保留当前位置，预取章节不会复活旧的阅读快照。

本地进度异步保存只更新对应会话的进度，不用旧书籍对象替换当前章节。进入后台会补存已显示的阅读位置。远程进度按服务地址和书籍串行发送，慢请求期间只保留最新待发快照；每次请求有有限超时，失败后仍可处理后续快照。上报为尽力而为，不保证断网或系统杀进程后的持久投递。

本地进度在同一个 IndexedDB 读写事务内读取最新书籍并更新，保留重新导入的正文和元数据；已删除的书籍不会被迟到进度写入复活。进度保存不重复申请持久存储，持久存储请求仍在书籍导入/保存入口执行。书籍保存、进度和删除均以事务提交完成为成功条件，提交前中止会返回失败。

`tools/verify_android_novel_reader.mjs` 与 `tools/verify_android_local_novel_storage.mjs` 已纳入 `verify:android-client`，覆盖会话切换、迟到结果、滚动恢复、进度队列与事务回滚。`node tools/serve_android_novel_reader_fixture.mjs` 提供实际阅读器代码的浏览器隔离夹具，使用独立来源的合成书籍和可延迟操作；测试控制面板可收起以操作底部阅读菜单。桌面浏览器与模拟依赖验证不替代 Android WebView 和真机生命周期验证。

## 原生视觉探索的生命周期

证卡和人脸探索将页面实例与本地会话分开处理：系统重建页面不会删除会话，恢复时以已完成存档和已确认照片为检查点；人脸动作中途重建会重新执行动作，不沿用上一实例的跟踪状态。退出时可选择保留已确认照片或明确删除本次记录，已完成后的返回不会撤销已保存照片。

每次拍照先写入独立临时文件，当前页面/步骤完成校验后才确认成标准照片。旧相机、识别和延时回调不会推进新页面或覆盖其照片；销毁时只解绑本页面自己的相机用例。人脸帧的释放不依赖会关闭的分析线程，退出后迟到的成功、失败或取消仍会释放资源。

存档清单先完整写入并同步临时文件，再原子替换正式清单，提交失败保留旧清单；旧版本遗留的“正式清单缺失但临时清单完整”可以在读取时恢复。错误提示中的“关闭”仅结束当前页面、保留已有文件，不等同于“退出并删除”。本地列表区分已完成、未完成可继续和无法恢复的记录，损坏记录不冒充可恢复，也不会自动删除。恢复时仅清理严格命名、属于旧进程的临时照片，当前进程仍可能在写的输出和未知文件不会被清理。

相机仅在页面恢复到前台且没有退出确认或致命错误时工作；各暂停原因独立解除。旧相机绑定、识别和延迟回调不会借用恢复后的新标记。退出确认、权限结果和错误消息会在重建后恢复；权限结果早于首次恢复时不提前启动相机。

存档复核的删除确认、分享窗口和导出错误互斥，并与当前记录绑定。暂停或销毁会使旧弹窗回调失效；重建只能重现未决确认，不自动删除或再次分享。确认删除先消费本次操作，再检查目录确实消失，失败不会报告删除成功。导出只授予所选照片的临时只读访问；分享窗口返回只解除操作等待，不表示接收应用已保存备份。请确认副本保存后再删除原记录。

`node tools/verify_vision_lifecycle.mjs` 使用隔离 JVM 夹具执行生产生命周期代码、资源释放及关键 Activity 回调；`node tools/verify_vision_visibility.mjs` 编译完整暂停状态 helper；`node tools/verify_native_vision_review.mjs` 执行复核操作的生产方法及旧行为对照。`node tools/verify_vision_exploration.mjs` 保留结构、私有存储及免责声明检查。JVM 中的 Android/CameraX/分享边界由替身提供，部分 Android 入口接线仅由静态守卫检查，不等同于真实相机、OCR/MLKit、分享目标或系统重建测试。该功能仍仅用于本地演示，不代表真实身份认证通过。

生命周期依据：[Android Activity 生命周期](https://developer.android.com/guide/components/activities/activity-lifecycle) 区分结束与配置重建；[Google Task 回调文档](https://developers.google.com/android/reference/com/google/android/gms/tasks/Task) 说明执行器和完成监听约定。项目测试另外执行本机实际依赖中的任务完成行为，不仅依赖文档推断。

预览在解码前按双边尺寸和像素数采样，解码及方向变换后再次检查实际尺寸与分配量；接受的单张 bitmap 最长边不超过 4096、总像素不超过 4194304、分配量不超过 16 MiB。方向处理包括 EXIF 八种旋转/镜像组合；不会改写原照片。解码或变换内存不足时最多尝试三次并继续缩小，失败时复核页显示可重开或导出原文件的提示，不据此删除记录。这里是单张 bitmap 的接受预算，不是应用峰值内存承诺，方向变换时源和目标可能同时存在。

证卡预览的解码、质量检查和识别启动失败会清理自己的临时输出并恢复当前拍摄；当前识别任务取消后也允许重新对齐拍摄。提交给 OCR 的图片不会在任务尚未结束时强制回收。若提交后注册监听失败，已注册的完成监听继续负责释放，旧业务回调失效；若完成监听根本未能注册，图片随识别任务的引用交由 GC 回收，不尝试猜测结束时间。

`node tools/verify_vision_preview.mjs` 编译完整生产解码器，用非对称合成像素检查八方向、尺寸和分配预算、重试及释放，同时保留旧源码失败对照。`verify_vision_lifecycle.mjs` 另外执行真实证卡确认、质量检查与 OCR 交接方法。位图、矩阵、EXIF 和编解码边界由可观测替身提供，不替代 Android 原生解码器、实际内存和屏幕显示测试。实现参考 [Android 大图采样指南](https://developer.android.com/topic/performance/graphics/load-bitmap) 及 [Matrix 变换顺序](https://developer.android.com/reference/android/graphics/Matrix#postScale(float,float))。

人脸动作仅累计同一 tracking ID 的连续有效、居中单人检测帧，保持原有自然表情／正面 7 帧、动作 4 帧、回正 7 帧。无人、多人、丢失跟踪、离框、非法边界或必需姿态／概率不可用会重置动作；动作阶段的框外笑脸不计数。检测失败或取消也从定位重新开始，不保留此前动作完成进度。这是本地动作演示，不是真实身份或活体认证。

相机帧和检测串行门各有一次性释放所有权。正常检测保持异步；只有拿到检测 Task 后监听器注册失败，才在已有 CameraX 分析线程中每 50ms 等待 `isComplete()`，待成功、失败或取消后明确关闭 ImageProxy，再恢复扫描。等待不依赖主线程、不持锁、不创建额外线程；中断标记会恢复。ML Kit 保持默认独立执行器，不得与该分析线程共用。不会因暂停、销毁或超时而提前关闭仍在推理的帧；若底层任务永不完成，不能承诺一定释放，也不会把超时当作完成。

`node tools/verify_vision_face_tracking.mjs` 用合成人脸结果执行生产动作方法，保留旧序列误推进对照；生命周期回归另外验证异步帧交接、部分注册失败与迟到回调。依据 [ML Kit 人脸处理／帧关闭要求](https://developers.google.com/ml-kit/vision/face-detection/android)、[CameraX 图像分析](https://developer.android.com/media/camera/camerax/analyze) 及 [ML Kit 默认执行器约定](https://developers.google.com/android/reference/com/google/mlkit/vision/face/FaceDetectorOptions.Builder#setExecutor(java.util.concurrent.Executor))。这些宿主验证不替代实际相机帧、模型行为或设备性能验证。

最后拍照的初始化失败会解除当前拍照标记并重新开始动作，保存阶段不提前显示“已完成”。每次拍照只接受首次成功或失败结果；启动失败后的迟到成功只清理该次临时输出，已交给成功处理方的文件不会被重复错误回调删除。`node tools/verify_vision_capture_callbacks.mjs` 用真实拍照方法和合成 CameraX／UI 边界验证这些状态，不调用设备或真实存档。

## 本机 TXT 导入与重复导入

新版系统文件选择先返回文件名与 URI，再由页面在同一批次内逐本读取、等待保存提交后读取下一本；一本文档失败仍继续后面的文件，同批重复 URI 只处理一次。通过 `deferredRead` 协商兼容旧原生返回的 `items`。文件选择结果缺正文、不可用或正文为空白时不会覆盖已保存的小说，最终摘要保留首条失败原因。这消除了新版流程在原生/桥接层整批保留正文的副本，不代表整个应用只缓存一本书：本地书库仍会缓存已导入章节。各导入操作拥有自己的忙碌标记，外部分享完成不会提前解除文件选择或目录扫描的忙碌状态。

原生 TXT 支持带 BOM 的 UTF-8、UTF-16LE/BE，以及无 BOM 的 UTF-8、GB18030。明确 BOM 的文本严格按对应编码解码，损坏内容不再静默替换为 `�`；无 BOM 先严格尝试 UTF-8，再严格尝试 GB18030。UTF-32 BOM 会明确提示转存 UTF-8；不会猜测无 BOM UTF-16，也不能识别所有碰巧是合法 GB18030 的错误编码。正文原本包含合法 `�` 或中间的 BOM 字符不会被删除。

单本原生输入仍限制为 80MiB（界面沿用“80MB”）。文件选择的可选元数据查询不支持时仍可尝试读取，已知超限或虚拟文档直接拒绝；实际字节上限独立生效，最多额外读取一个字节判断超限。连续八次零字节响应会停止读取并提示重试，这不是对提供方永久阻塞调用的超时保证。内联分享按实际 UTF-8 字节计数并执行相同上限，导出预筛也不再为计算大小先分配整份字节数组。读取/解码的内存不足有明确失败分支，但不保证在系统整体内存耗尽或进程被杀后恢复。

有明确章节标题的 TXT 会保留首章前的非空序言，正文保持连续章序。导出本地 TXT 不再重复添加书名或自动生成的序言标题，避免导出后再次导入时逐轮增加内容；远程离线缓存仍保留书名头。

系统文件选择、目录扫描和外部打开统一使用原始文档 URI 生成稳定书籍标识，不把导入时间当作文件修改时间。同 URI 重复导入会更新正文并复用可确认的阅读位置：章节结构不变时保留原位置，插入序言或章节变化时按唯一章节标题/正文重新定位；无法消除歧义或原章已移除时不猜测新位置。旧版本已经丢失 URI 的记录保持原样，不按同名或相似正文自动合并，因此首次重新导入此类文件仍可能新增一本。

同书重导前先补存并结束旧阅读会话，新的内容提交后使旧进度回调失效；本地书库读取失败会停止导入，不以“没有旧书”继续覆盖。

原生外部打开/分享按进程内队列逐项消费，慢读取不持有队列锁。旧消费结果只结束自己的请求，不能清除期间到达的新文件；多个页面实例不能同时读取同一请求。前端在忙碌期间记住新通知，成功后继续取下一项，坏文件报错后仍处理队列内其他文件；遇旧页面实例仍在读取时仅安排一个延后重试，不在空队列上循环。这里不提供系统杀进程后的持久导入队列或原生读取与 IndexedDB 保存之间的事务承诺，失败文件可以再次通过系统分享导入。

`verify:android-client` 包含 TXT 编码、字节读取、原生消费、文件选择及前端保存顺序的回归。测试使用合成文本、完整 JVM 帮助类与抽取的生产入口，Android 提供方和桥接依赖使用测试替身；不读取真实书籍，也不替代真机 SAF/WebView 与 Android 字符集实现验证。

## 文件下载与旧版存储权限

WebView 的 HTTP(S) 文件下载（例如远程小说 TXT、音乐下载）交给系统 DownloadManager，目标仍为公共“下载”目录。Android 7–9（API 24–28）仅在用户点击下载时检查并请求 `WRITE_EXTERNAL_STORAGE`，拒绝后可以重新点击；系统要求说明时先显示可取消的用途说明。Android 10 及以上不请求这项权限，清单声明以 `maxSdkVersion="28"` 限定范围。此规则依赖本项目当前 `targetSdkVersion >= 29`，参见 [Android DownloadManager 公共目录要求](https://developer.android.com/reference/android/app/DownloadManager.Request#setDestinationInExternalPublicDir(java.lang.String,%20java.lang.String)) 和 [运行时权限流程](https://developer.android.com/training/permissions/requesting)。本地小说的 SAF 导入/导出不走此权限路径。

权限等待期间保留所选文件元数据，连续点击不会覆盖正在确认的文件。页面重建复用或恢复待处理状态；恢复说明框不会自行申请权限或入队。系统回调到达后先消费待处理请求，再重新检查实际授权状态，仅提交一次。下载 ViewModel 不持有 Activity；它保留系统保存的状态，但不接受导出的启动 Intent extras 作为默认待下载参数，正常文本导入不受影响。

新建和恢复的下载请求均验证 HTTP(S)、主机及无内嵌凭据约束；文件名保留响应头、查询参数、URL 推断的优先级，并清理路径分隔符、控制字符和 `.` / `..`。系统服务不可用、目录不可用、权限变化或提交异常都会提示失败；只有系统返回正数任务 ID 才显示“已加入下载队列”，这不代表文件已下载完成。不保证任意进程崩溃与系统下载服务之间的持久事务或断网自动恢复。

`node tools/verify_native_web_downloads.mjs` 编译真实下载实现与 MainActivity，使用隔离 Android/AndroidX 替身验证版本分流、权限/说明回调、重建、错误反馈、请求校验和启动参数隔离；已纳入 `verify:android-client`。系统权限界面、DownloadManager 实际落盘和设备厂商差异仍需真机验证。

## 前置条件

- Node.js >= 24（用于 `cap sync` 与 Web 资源构建）。
- Android SDK，且 `adb` 在 `~/AppData/Local/Android/Sdk/platform-tools/` 下（安装脚本会自动探测）。
- JDK 21：脚本会检查 `C:\Program Files\Android\openjdk\jdk-21.0.8`、`JAVA_HOME` 和 Android Studio JBR；找不到 major version 21 时直接失败，不会回退到其他 Java 版本。

## 构建脚本：`build-debug.ps1`

常用参数：

| 参数 | 说明 |
| --- | --- |
| `-Install` | 构建完成后自动 `adb install -r` 到已授权的真机。 |
| `-NoSync` | 跳过 `cap sync android`（仅当 `www/` 已是最新时使用）。 |
| `-VersionCode <n>` | 覆盖 APK 的 versionCode（传给 Gradle `-PfanhaoVersionCode`）。 |
| `-VersionName <string>` | 覆盖 versionName（传给 Gradle `-PfanhaoVersionName`）。 |
| `-LocalOnly` | 仅允许 `100000000..2100000000` 的非发布构建；脚本向 Gradle 传专用 `fanhaoLocalOnly=true` gate，并在身份回读后写入同 APK 绑定的 local-only 标记；不能与 `-Install` 同用，也不能进入发布脚本。 |

普通 debug 构建只接受 `1..99999999`，保留 Android versionCode 的恢复空间；`versionName` 会先 trim，空白值在 Gradle 启动前失败。构建完成后脚本用 SDK `aapt` 与 `apksigner` 回读包名、版本和完整 signer 数量，且只接受既有 debug 更新证书。

Gradle、Android Studio、`cap run` 与 `FANHAO_VERSION_CODE` 也受同一 namespace gate：未显式进入 local-only 路径时最多只能构建 `99999999`。高段必须同时携带专用 Gradle property；`packageDebug` 开始前先在不会被 APK 输出清理覆盖的位置原子写 fail-closed guard，成功产出 APK 后再写 pending sidecar。`build-debug.ps1 -LocalOnly` 最后用 APK 大小、SHA 与 signer 绑定的完整 marker 原子替换 pending，并清除 guard；普通构建只在成功后清除两者，因此失败或中断不会把高段输出误当成可发布产物。

无参数 `npm run build:debug` 与 `npm run install:debug` 都从 tracked 的 `android-client/version.json` 读取默认身份；当前固定为 `26081190 / 0.1.26081190-debug`。因此安装脚本不会再意外生成 `1 / 1.0`；`install:debug` 只允许 contract 当前的 code/name，显式传入更高或不同身份会在 JDK、Gradle 和 ADB 之前失败，必须先通过受审阅提交提高 `version.json`。身份通过后，脚本仍只在 ADB 存在已授权设备时执行 `adb install -r`。

普通、仅构建的显式 `-VersionCode` / `-VersionName` 仍可用于边界内的临时验证，但不会修改 contract，也不会推进 publish floor。直接绕过脚本手工执行 `adb install` 无法受此 gate 保护，可能把设备推进到未记录版本，属于需要人工避免的剩余操作风险。

典型流程：

```powershell
cd android-client

# 1) 同步 Web 资源 + 构建 debug APK
powershell -ExecutionPolicy Bypass -File ./build-debug.ps1

# 2) 构建并直接安装到手机
powershell -ExecutionPolicy Bypass -File ./build-debug.ps1 -Install
```

等价 npm 脚本（定义在 `android-client/package.json`）：

```powershell
npm run sync             # cap sync android
npm run build:debug      # 构建 debug APK
npm run install:debug    # 构建并安装
npm run open             # 用 Android Studio 打开原生工程
npm run run:android      # 直接跑起来
```

根目录 `npm run verify` 中的 Android security lane 是自包含的：root hook 会按 lockfile（含 devDependencies）安装 `android-client` 依赖，security verifier 随后在系统临时目录复制原生工程、链接本地 lock-pinned Capacitor 依赖并执行 `cap sync android`，确认 Cordova Gradle bridge 后才运行 Gradle fixtures。clean checkout 只需先执行根目录 `npm ci`；真实工作树不依赖人工 sync，也不会被 verifier 的同步、并发或中断改写。

产物位置：`android-client/android/app/build/outputs/apk/debug/app-debug.apk`。

## 自动更新通道

服务端提供 `/api/android/update` 清单与 `/api/android/update/apk/:channel/:file` 下载，
客户端在应用内检查更新并从该通道拉取 APK，无需走应用商店。

客户端固定依次使用 `http://192.168.31.86:29998` 与 `http://xc213618.ddns.me:29998` 检查更新；局域网源连接失败或未发现更新时检查公网备用源。更新地址独立于保存的内容服务地址，并在设置的“应用更新”中显示两个默认地址与本次实际使用的来源。未登录时，公网地址只开放只读更新清单和清单精确引用的 APK 下载，不开放媒体库、设置或其他 API。

“内容服务地址”下的默认快捷选项同样是 `192.168.31.86:29998` 与 `xc213618.ddns.me:29998`，移除旧的 `192.168.192.50` 和 `172.21.96.1` 预设，但不覆盖已保存的自定义地址。选择域名会保存并尝试连接该内容服务，不会绕过服务端鉴权；公网内容访问仍受下述网络与登录边界限制。

应用已是最新版本时保留“检查更新”按钮，每次点击都重新读取已安装版本并请求最新清单；检查中禁止重复提交，切换服务后丢弃旧检查的迟到结果。打开系统安装器后，App 提供“检查安装结果”作为手动恢复入口；原生暂停/恢复回调和可见性回调会在返回时核对本机安装版本，取消安装后恢复更新按钮，授权返回也不会自动开始安装。下载、检查和安装状态读取失败分别显示对应原因，重试安装状态读取不会重复下载 APK。

推荐从仓库根目录使用一键验证发布入口：

```powershell
npm run release:android-debug -- -Notes "本次更新说明"
```

`release-debug-update.ps1` 先运行 `verify:android-release`，再调用下述原子发布脚本，最后验证本机和公网清单的新旧版本可用性、APK HEAD、完整公网下载、大小、SHA-256、包身份与 signer。它不隐式安装 APK。`-PlanOnly` 只查看版本计划，`-VerifyOnly` 只复核当前发布；若原子发布已成功而公网验收失败，命令会明确失败，但不会伪装成未发布或回滚已经提交的清单。

`publish-debug-update.ps1` 负责把构建好的 APK 放到 `data/android-update/`（服务端从该目录读取清单与文件），
配合 `src/modules/system/server/android-update/service.js` 对外提供更新服务。

发布脚本会从 tracked 的 `android-client/version.json` 高水位，以及 debug/release 的受验证 `latest.json` 和两个通道内全部规范 APK，取全局最高 versionCode；当前 contract floor 是 `26081190`，所以即使发布根只有 `26073102`，自动计划也从 `26081191` 开始。`app-debug.apk` 是可缺失、陈旧、损坏或 local-only 的临时构建输出，永远不参与历史高水位。自动值和显式值都必须严格递增且不超过 `99999999`。旧清单只有在同时缺少 `packageName`/`signerSha256`、其余字段完整，并且所指 APK 的大小、SHA、版本、包名和单 signer 全部实测一致时才兼容读取；新清单始终写全身份字段。

发布成功后的版本化 APK 与 `latest.json` 会自然成为后续计划的持久历史；发布脚本不会修改源码 contract。`version.json` 是在发布历史缺失或迁移时仍然生效的最低基线，只能通过单独、受审阅的 Git 变更同时提高 `currentVersionCode`、`highWaterVersionCode` 和对应默认名称，不得下降。

因为自动发布候选必然高于当前 contract，`publish-debug-update.ps1 -Install` 已明确废弃并会在 JDK、Gradle 与 ADB 之前拒绝，避免把设备推进到尚未受审阅记录的身份。真实发布会在构建前和原子提交前两次确认同一组已授权 ADB 设备仍然可见，任一时点不可见或发生变化都拒绝发布，但发布命令本身不会安装 APK。发布后可由应用内更新链安装，也可运行 `npm run install:android-published`：该入口只读取仓库发布目录的 `latest.json`，重新验证规范文件名、大小、SHA-256、包名、版本和单 signer，再对唯一已授权设备执行不允许降级的 `adb install -r`，并回读已安装版本；多设备必须显式传 `-Serial`。它不构建当前源码，因此不会把“与发布版同版本但字节不同”的临时 APK 冒充为发布产物。未发布源码构建仍受 tracked `version.json` 安装契约保护。

APK 与清单先写入发布目录内的临时文件并完成回读验证，新版本 APK 使用不可覆盖的版本化文件名，`latest.json` 最后原子替换。下载端只提供当前 `latest.json` 精确引用的 APK，失败或中断产生的非当前文件不能经更新接口下载。

当前仓库只收口了 debug 签名发布链。release Gradle 产物没有稳定 signingConfig，因此未签名 release APK 不得发布或用于覆盖安装。

## 网络与权限要点

`capacitor.config.json` 关键配置：

- `server.androidScheme: "http"`：保留已发布版本使用的 `http://localhost` WebView origin。不要在没有数据迁移方案时改成 `https`，否则 Web Storage / IndexedDB 会切换 origin，已有本地小说和设置会表现为不可见。
- `server.cleartext: true` 与 `android.allowMixedContent: true`：兼容既有 HTTP API / 媒体地址；它们不提供传输加密，公网应配置 HTTPS。
- 未配置 `server.allowNavigation`：远程页面不能在应用 WebView 内导航，因而不能获得 Capacitor 原生桥权限；外部页面应交给系统浏览器处理。
- `android.captureInput: true`：放开输入框捕获（避免某些 WebView 输入问题）。

Android 远程内容使用显式密码登录：设置中填写服务地址和访问密码后连接，原生端保存按 origin 隔离的会话，API 使用 bearer token，图片和原生 HTTP 请求只向已登录的同一服务附加会话。不要通过手工复制浏览器 / App Cookie 的方式登录。会话最长 30 天，服务密码变更后失效，不保存密码或将会话放进媒体 URL；系统备份排除原生会话。文件删除和后台管理仍保留原有局域网权限限制。HTTP 兼容现有地址，但不提供传输加密，公网部署应使用 HTTPS。源码、fixture、构建和真机验证状态以本轮交付记录为准。

> 调整 `capacitor.config.json` 后需重新 `cap sync android` 并重新构建，配置才会进原生层。

## 冷启动与页面恢复

启动时先显示目标页面的简短加载提示，静态首页与默认底部导航在 HTML 层保持隐藏。模块和资料库初始化后，先准备恢复页面的加载状态、导航标签与选中项，再显示主界面；不会先闪出番号首页再跳到套图、漫画或其他上次页面。深链接优先于上次页面，启动提示沿用应用主题并尊重减少动态效果的系统偏好。

启动流程抛出异常时停止转圈，显示失败原因与“重新打开”按钮。`verify:browser-behavior` 使用真实 Android 壳覆盖脚本、模块目录、资料库响应延迟，套图/漫画恢复、欧美深链接、首次启动以及失败后重试。

## 调试建议

- 真机调试：USB 调试授权后 `build-debug.ps1 -Install`，日志用 `adb logcat`。
- 改了 `android-client/www/` 的 Web 代码后，必须 `cap sync android`（即 `npm run sync`）再构建，原生层才会拿到新资源；小游戏源文件只修改根目录 `public/games/`，同步脚本会将其复制到 `android-client/www/games/`。
- 改了 `android/` 原生代码（如权限、插件）则直接走 Android Studio 打开 `android/` 工程。
