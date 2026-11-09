# 抖音下载管理器更新记录

## [0.4.0-test.1](https://github.com/xincheng213618/FanHao/compare/douyin-manager-v0.4.0-test...douyin-manager-v0.4.0-test.1) (2026-11-09)


### Features

* add photo collection health panel ([164d894](https://github.com/xincheng213618/FanHao/commit/164d894c4fea65923508c66124587685944c9226))
* add standalone gallery maintenance and library updates ([f161bd1](https://github.com/xincheng213618/FanHao/commit/f161bd148fc97bf774fe30861f72770a33686b44))
* **android:** improve mobile UX and release 0.1.26102900-debug ([99146ea](https://github.com/xincheng213618/FanHao/commit/99146eab6413c2dc5b29c5b4b71dc8206616f27b))
* **android:** sort photo collections by issue number ([b81afce](https://github.com/xincheng213618/FanHao/commit/b81afcefa3717bec0144eee514aee5dd64e516ab))
* integrate account and media reliability updates ([2a09836](https://github.com/xincheng213618/FanHao/commit/2a098367b941a0069db258d3e0adbc34d8ca4193))
* integrate FanHao product updates and verification ([8fc8e8c](https://github.com/xincheng213618/FanHao/commit/8fc8e8cadf4ee0d998fa269e5a5e6c4ce182b2cb))
* move photo health to an analysis page and compact the toolbar ([f420fe5](https://github.com/xincheng213618/FanHao/commit/f420fe51713d863f3d9286675c506f7cffd2f09d))
* **photos:** bump cover generator to v3 and add cover warm-up script ([900afdc](https://github.com/xincheng213618/FanHao/commit/900afdc43dc28b161fc00f2ceb7c1be80d38fab4))
* **photos:** default web collections to descending issue order ([e70b865](https://github.com/xincheng213618/FanHao/commit/e70b8654c76a8da852f52e45001b0f0fb98f8d96))
* **photos:** group categories and customize gallery covers ([121ef95](https://github.com/xincheng213618/FanHao/commit/121ef958fffc003fa5c9ab340afe789554e80d48))
* **photos:** identify Western releases on favorites shelf ([8ced0e9](https://github.com/xincheng213618/FanHao/commit/8ced0e90003b46fca85fd16a07a3ef251a964dc4))
* **photos:** link album metadata and reveal source archive ([3c61de5](https://github.com/xincheng213618/FanHao/commit/3c61de5323a5805eee0e710d3ddc3b6b5e40920b))
* **photos:** organize category routes and album cards ([d336307](https://github.com/xincheng213618/FanHao/commit/d33630733913c850267bb74ba56c2c9186caef2f))
* **photos:** persist gallery indexes and publisher relationships ([264433b](https://github.com/xincheng213618/FanHao/commit/264433b5811fc1f6cce0fc1e00c194522a251dc5))
* **web:** improve media browsing, playback and recovery ([535d535](https://github.com/xincheng213618/FanHao/commit/535d535f627972e3475cf8b3995bb98cedac668a))


### Bug Fixes

* **file-workflows:** drain previews and ignore obsolete UI requests ([55e5eaf](https://github.com/xincheng213618/FanHao/commit/55e5eafc4954045a9f1ce68a49465a1d7a25f716))
* **http:** contain request errors and honor JSON encoding preferences ([f8547fb](https://github.com/xincheng213618/FanHao/commit/f8547fb4c923c6510f873d8493dc3af4f0e7489c))
* **manga:** streamline library cards and chapter search ([a9858b3](https://github.com/xincheng213618/FanHao/commit/a9858b3a5fd4b5b12afb45f1a7d27b0ef3f9c070))
* **music:** preserve path identity and playlist request ownership ([348d67d](https://github.com/xincheng213618/FanHao/commit/348d67d0a53394726558876e09e5a6aa54573a7e))
* **photos:** discard temporary archive video after cover extraction ([6bb38b9](https://github.com/xincheng213618/FanHao/commit/6bb38b96339bc72cbbb67fc19c5b1b045b3cb895))
* **photos:** group favorite collections by person folder ([346e11d](https://github.com/xincheng213618/FanHao/commit/346e11d43e88d62f913c9b7393754ea3059126eb))
* **photos:** retry cover warm-up through 503s and service outages ([ba38912](https://github.com/xincheng213618/FanHao/commit/ba389127ad3656cdf23356e5002c309214a33b6c))
* **short-videos:** reuse prepared galleries during reel switches ([3147ea5](https://github.com/xincheng213618/FanHao/commit/3147ea51d70ba3a15657ca6fed3203678bd0958c))


### Performance Improvements

* **accounts:** reuse session reads and bound playback history work ([2cea8b9](https://github.com/xincheng213618/FanHao/commit/2cea8b9ccea7cf8c9586ee3b3b09869ea7221adf))
* **android:** synchronize mobile assets and reduce request churn ([e8dbbbb](https://github.com/xincheng213618/FanHao/commit/e8dbbbb021e0e5f9ee22846bc26189d39a64e0fe))
* **fanhao:** reuse people snapshots, searches and cover state ([5b7f56f](https://github.com/xincheng213618/FanHao/commit/5b7f56f583606a07d10811b9da53c5418efe0405))
* index download manager shared-player ordering ([2b9dc6f](https://github.com/xincheng213618/FanHao/commit/2b9dc6fe42b86d12ac742df11e6142ca854176b4))
* **media:** move manga paging off the main thread and bound media reads ([4624241](https://github.com/xincheng213618/FanHao/commit/4624241b091a8031ad35302b714bbe117683fa8e))
* **novels:** avoid scans for pages beyond the result count ([6cbffec](https://github.com/xincheng213618/FanHao/commit/6cbffecf7588f8686ebfa77988bff9520f3260a1))
* preserve music background during fullscreen transitions ([f110040](https://github.com/xincheng213618/FanHao/commit/f110040d02b1eb579461248da9960e97370fa4d2))
* **readers:** streamline music requests and novel collection reads ([d985803](https://github.com/xincheng213618/FanHao/commit/d985803a0d7e542a8faf21e58451b566296c53d8))
* reduce library query and client pagination overhead ([2441605](https://github.com/xincheng213618/FanHao/commit/24416052930de01a364920ecfdc800580625bbee))
* reuse Android manga chapter cards on pagination ([bfb8306](https://github.com/xincheng213618/FanHao/commit/bfb83068aea34aa4972ceda0a0cbeca1162b08d9))
* **short-video:** streamline list caches and worker lifecycle ([fea6015](https://github.com/xincheng213618/FanHao/commit/fea6015a7b2c9697af02f0d4660a8469d4e67997))

## 0.4.0-test (2026-08-25)

- 优化采集、下载和主页维护流程。
- 完成 Windows 安装包构建、测试及 GitHub Release 附件校验。

完整说明见 [douyin-manager-v0.4.0-test](https://github.com/xincheng213618/FanHao/releases/tag/douyin-manager-v0.4.0-test)。
