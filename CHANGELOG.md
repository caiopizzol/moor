# Changelog

## [0.55.0](https://github.com/caiopizzol/moor/compare/v0.54.1...v0.55.0) (2026-09-06)


### Features

* **api:** centralize environment updates ([#155](https://github.com/caiopizzol/moor/issues/155)) ([165f58b](https://github.com/caiopizzol/moor/commit/165f58bb34cdbc7bf25be5acaceaa04dccfe3b98))
* **api:** centralize project deploy ([#150](https://github.com/caiopizzol/moor/issues/150)) ([1c9de19](https://github.com/caiopizzol/moor/commit/1c9de19106188d9edbe0f7acc1a99594192744d6))
* **api:** centralize project restart ([9dc371c](https://github.com/caiopizzol/moor/commit/9dc371ce64e40b1c5e8d3061738e1c6d8e159b74))
* **api:** return trackable manual cron run IDs ([c670687](https://github.com/caiopizzol/moor/commit/c670687992d815f982fc1deb9bc220a54b4b507d))
* **cli:** add agent-friendly environment updates ([6afc851](https://github.com/caiopizzol/moor/commit/6afc8519fe7d923cf9372e21d617281349101590))
* **env:** centralize environment deletion and restart ([656d2cb](https://github.com/caiopizzol/moor/commit/656d2cbad50c9ff821e637f4ab35c040ef162f2a))
* **skill:** add Moor CLI agent workflow ([#154](https://github.com/caiopizzol/moor/issues/154)) ([02d521b](https://github.com/caiopizzol/moor/commit/02d521bf78eed29c9236e5d27df674242f4b95ec))


### Bug Fixes

* **api:** preserve terminal cron run records ([e423d3c](https://github.com/caiopizzol/moor/commit/e423d3c4cccda77b3dcab7fa586900ee5ddcdb98))
* **api:** reject invalid cleanup request bodies ([295ae28](https://github.com/caiopizzol/moor/commit/295ae2822b770ccd9716fbfd37c6b8140fb70ab5))
* **api:** report container stop failures ([f0a7900](https://github.com/caiopizzol/moor/commit/f0a79004738de4cb6ce8a97ea64ecc7cb007aae6))
* **api:** report incomplete cron cancellation honestly ([4abf843](https://github.com/caiopizzol/moor/commit/4abf843b0010e75805da658056ead2ee96dd98c3))
* **api:** validate async execution input ([8f0e6aa](https://github.com/caiopizzol/moor/commit/8f0e6aac8467efc869d47ac3180bb685550092a3))
* **api:** validate cron state and configuration ([afa4ade](https://github.com/caiopizzol/moor/commit/afa4ade9059dd39957f4b5e12fceb1f182292c60))
* **api:** validate drain enable requests ([92dce33](https://github.com/caiopizzol/moor/commit/92dce33739667d46c9820daefa85c1a4a33b9f6f))
* **api:** validate self-update request bodies ([b79d3ca](https://github.com/caiopizzol/moor/commit/b79d3caff6d07f78f4752fd1eaed73c051be8602))
