# Changelog

## [0.7.0](https://github.com/caiopizzol/moor/compare/cli-v0.6.0...cli-v0.7.0) (2026-09-06)


### Features

* **api:** centralize project restart ([9dc371c](https://github.com/caiopizzol/moor/commit/9dc371ce64e40b1c5e8d3061738e1c6d8e159b74))
* **cli:** add agent-friendly deploy command ([#151](https://github.com/caiopizzol/moor/issues/151)) ([879fc42](https://github.com/caiopizzol/moor/commit/879fc42ca8ee52ac205bda575490000e8e0e64d8))
* **cli:** add agent-friendly environment updates ([6afc851](https://github.com/caiopizzol/moor/commit/6afc8519fe7d923cf9372e21d617281349101590))
* **cli:** add asynchronous job commands ([e5a7f6a](https://github.com/caiopizzol/moor/commit/e5a7f6ab11f46b6305d0031c3846e071e23df735))
* **cli:** add cron configuration commands ([6b8261c](https://github.com/caiopizzol/moor/commit/6b8261c5a0ccbdd76f9eefb5d8f33e5cd1730bba))
* **cli:** add deploy process overrides ([261bb84](https://github.com/caiopizzol/moor/commit/261bb84502c91b1f807a142f32015a63ad880152))
* **cli:** add guarded server cleanup ([4e08da9](https://github.com/caiopizzol/moor/commit/4e08da95a9975562532caea94b7af06818b4dc89))
* **cli:** add JSONL rebuild output ([63b7787](https://github.com/caiopizzol/moor/commit/63b7787d85887dd0f612e5c9af626bc3a1592418))
* **cli:** add machine-readable environment listing ([6779e44](https://github.com/caiopizzol/moor/commit/6779e44ef6b03a2a1c13caff964b970f1ef48966))
* **cli:** add machine-readable exec output ([2ecd479](https://github.com/caiopizzol/moor/commit/2ecd479af5e74707c0d71dc72b48d5520b9f1886))
* **cli:** add machine-readable host stats ([52088c0](https://github.com/caiopizzol/moor/commit/52088c050d1864dfdc9e15fac6ed44c019752edb))
* **cli:** add machine-readable logs ([b946831](https://github.com/caiopizzol/moor/commit/b946831f9c6571de05f87cf8a0c91b3171047c1b))
* **cli:** add machine-readable resource history ([2ffcabe](https://github.com/caiopizzol/moor/commit/2ffcabeeada62612e8e4603d03fc71f9db097332))
* **cli:** add machine-readable restart ([9ee6aab](https://github.com/caiopizzol/moor/commit/9ee6aab563c19b2a7b2a698b4380b912451781e5))
* **cli:** add project inspection commands ([1e9d436](https://github.com/caiopizzol/moor/commit/1e9d436336ca99a2102bcdbe8088da185f2f1a55))
* **cli:** add read-only run inspection ([53b3c6e](https://github.com/caiopizzol/moor/commit/53b3c6e8ea819c85a48c8ef81d52becdf7fee976))
* **cli:** add registry credential management ([0b52bf7](https://github.com/caiopizzol/moor/commit/0b52bf78beaa41c4c0f3d6fdf2e61fd79ced4ee6))
* **cli:** add server database backup ([8b3bc55](https://github.com/caiopizzol/moor/commit/8b3bc55a01f1bc9975e3978c332c8b94684d2db6))
* **cli:** add server drain controls ([301eaee](https://github.com/caiopizzol/moor/commit/301eaee3c4763a11746f74b1b2b4d2f42a2c8006))
* **cli:** add source credential onboarding ([2a24ac0](https://github.com/caiopizzol/moor/commit/2a24ac018de79979890fa10e36e5e0cf1e9c0fae))
* **cli:** add source credential updates ([5f0b1fd](https://github.com/caiopizzol/moor/commit/5f0b1fde9e106b56b659e50e0004352f74a341ae))
* **cli:** add stop command with JSON output ([124e050](https://github.com/caiopizzol/moor/commit/124e0508ba78a5b5f369ef3879832d1dd8b102d3))
* **cli:** cancel tracked cron and build runs ([2785042](https://github.com/caiopizzol/moor/commit/2785042c82811e10eedb4af0191d09d3860c9b30))
* **cli:** expose deploy resource limits ([5ef2339](https://github.com/caiopizzol/moor/commit/5ef2339b87e32ce9dc1c62bcc6e9a1a94e15d787))
* **cli:** inspect server update status and audit ([59e5058](https://github.com/caiopizzol/moor/commit/59e5058de9b387b003128b462b7f08f3324b7254))
* **cli:** request tracked server self-updates ([ddccf8b](https://github.com/caiopizzol/moor/commit/ddccf8b26618e43618ac9503abc7ff1c3ce5dc23))
* **cli:** support injected files in deploy ([2858a3a](https://github.com/caiopizzol/moor/commit/2858a3a500d60e02decc5e034443dd540834120c))
* **cli:** support persistent volumes in deploy ([1519595](https://github.com/caiopizzol/moor/commit/1519595346dde969036b09d3efda041bd0bff1c7))
* **cli:** trigger tracked cron runs ([4e8f6b2](https://github.com/caiopizzol/moor/commit/4e8f6b25521d068777302475cf2f61f82cfa4a67))
* **env:** centralize environment deletion and restart ([656d2cb](https://github.com/caiopizzol/moor/commit/656d2cbad50c9ff821e637f4ab35c040ef162f2a))


### Bug Fixes

* **cli:** centralize project response validation ([e7115d1](https://github.com/caiopizzol/moor/commit/e7115d1c84daf0580754b61c82e41523a417f2fe))
* **cli:** preflight cron input reads ([4df31d8](https://github.com/caiopizzol/moor/commit/4df31d80857685508a54713e0bb259e7c81b77d7))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @moor-sh/contract bumped to 0.2.0
