// SHA-256 of every Step 0 rule file (`.rulesync/rules/toolgate-router.md`) that `toolgate init` has written, oldest first.
// `toolgate update` replaces the rule only when the file is byte-identical to one of these; anything else was edited by
// the user and stays. When the template or header changes, ADD the new hash: never remove one.
export const KNOWN_RULE_SHA256 = Object.freeze([
  "c46c8808a9f326ca5f297458c09431bae13bbf19f3e04f54f889fd56f8e4045e", // d8a917e init
  "13ea5affb0f543cbb514fe8082163e4b97106656b1b27b5f15dd2ca969adae8f", // bf28a88 daemon repair
  "f035a6042802a8c682703a6ba2a1d6087ba59f77255d9e64157060f6f7c7efc6", // 3a98881 toolgate need
  "4cd10f9a4e4a01c3f9cc94313bedefc5b1906df0302bec6da3fc81e131c4b21f", // 3d1e0c4 commands
  "f26dbda45d47395bc59b2c4ba1e341b6f9045d70760ba584d2aab47d03151ff9", // 0977056 subagents
  "30354c0dfb783cb57ccae5f962f6161bbd482cec358bbde5f54a44b9a433895b", // b9f4030 subagents at launch
  "de4190c0024723e6fa76a4eeb004c05fa7099db9887086b6e86af4dfe134bbd9", // b84c846 windowed reads
  "08b2d10349b65f216f736ea0870697b9c5bcd0036592255afc23d5d3411e80fd", // #19 revealed and dormant
  "27963af02758af73e5d67d94a0ae9755f4f973c4302b534030083dd5f1620509", // #19 hint placeholder and no commands from instructions
  "6442f86f7afb4851a818a1576644714a54d0d7cdbb29dfe3e4d73abbabedf017", // daemon down or hung warnings (#298)
]);
