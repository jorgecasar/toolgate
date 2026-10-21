// `toolgate permissions install|update|status|list|review|remove [--grant]`: see `assets/reviewCli.js`. `deny` and `ask` rules
// only narrow; `allow` rules are grants and stay inactive until the user opts in with `--grant` and types a second `yes`, per
// unit and per hash of the allow list.
import { printable } from "../assets/common.js";
import { reviewWaiting, unitKey } from "../assets/approval.js";
import { createReviewCli } from "../assets/reviewCli.js";
import { askInTerminal } from "../init.js";
import { buildPermissionImport } from "./import.js";
import { PERMISSION_KIND, PERMISSIONS_LOCAL_IGNORED, grantHash, grantKeyOf, isGranted, previewPermission, scanPermissions } from "./install.js";

// The grant text of a unit: only its allow rules, with the broad ones marked.
const grantPreview = (unit) => previewPermission({ ...unit, description: "", deny: [], ask: [] }).replace(/^[^\n]*\n/, "");

// One grant to ask about: its own text (the allow rules, broad ones marked) and its own question, so that it is plainly a second decision.
const grantItem = ({ name, level, allow, hash, cwd }) => ({
  name,
  level,
  hash,
  key: grantKeyOf({ projectDir: cwd, level, name }),
  preview: `GRANT the allow rules of ${printable(name)}:\n${grantPreview({ name, allow })}`,
  question: `Grant these allow rules of ${name}? Type yes to grant: `,
});

// Units that are approved and have allow rules that are not granted yet: what `--grant` asks about.
function ungranted({ cwd, userDir, config, approvals }) {
  const off = config?.permissions?.disabledLevels ?? [];
  return scanPermissions({ projectDir: cwd, userDir, levels: ["user", "project", "local"].filter((l) => !off.includes(l)) })
    .filter((unit) => !unit.error && unit.allow.length && approvals.has(unitKey({ projectDir: cwd, level: unit.level, kind: "permission", name: unit.name }), unit.hash) && !isGranted(approvals, { projectDir: cwd, level: unit.level, permission: unit }))
    .map((unit) => ({ ...grantItem({ name: unit.name, level: unit.level, allow: unit.allow, hash: grantHash(unit), cwd }), note: "(allow rules not granted)" }));
}

export const runPermissions = createReviewCli({
  kind: PERMISSION_KIND,
  noun: "permission",
  plural: "permissions",
  scan: scanPermissions,
  preview: previewPermission,
  row: (unit, state, { approvals, cwd }) => [printable(unit.name), unit.level, state, `deny ${unit.deny.length}, ask ${unit.ask.length}, allow ${unit.allow.length}${unit.allow.length ? (isGranted(approvals, { projectDir: cwd, level: unit.level, permission: unit }) ? " (granted)" : " (not granted)") : ""}`],
  json: (unit, state, { approvals, cwd }) => ({ name: unit.name, level: unit.level, description: unit.description, state, deny: unit.deny, ask: unit.ask, allow: unit.allow, granted: isGranted(approvals, { projectDir: cwd, level: unit.level, permission: unit }) }),
  ignored: PERMISSIONS_LOCAL_IGNORED,
  buildImport: buildPermissionImport,
  usage: "toolgate permissions: usage: toolgate permissions install <github:owner/repo | git url> [name...] [--grant] [--ref r] [--path p] [--exclude n] [--user | --local]\n",
  // With --grant, review also asks about allow rules that are approved but not granted yet.
  extraPending: ({ cwd, userDir, config, approvals, ctx }) => (ctx.grant ? ungranted({ cwd, userDir, config, approvals }) : []),
  // With --grant, a unit that was just approved gets its second question: the grant of its allow rules.
  async afterReview({ waiting, approvals, level, ctx, allowed, approved }) {
    if (!ctx.grant) return;
    const { stdout, ask = askInTerminal, cwd } = ctx;
    const items = waiting
      .filter((item) => approved.includes(item.name) && item.allow?.length)
      .map((item) => grantItem({ name: item.name, level, allow: item.allow, hash: item.grantHash, cwd }));
    if (items.length === 0) return;
    const result = await reviewWaiting({ waiting: items, approvals, show: (item) => `\ntoolgate: ${level} permission grant waiting for your approval:\n${item.preview}`, ask, print: (text) => stdout.write(text), allowed });
    if (result.approved.length) approvals.save();
  },
  statusLines: ({ cwd, userDir, config, approvals }) => {
    const names = ungranted({ cwd, userDir, config, approvals }).map((u) => `${printable(u.name)} (${u.level})`);
    return names.length ? [`not granted: the allow rules of ${names.join(", ")} (run \`toolgate permissions review --grant\`)`] : [];
  },
  onRemove: (approvals, { cwd, level, name }) => {
    approvals.revoke(unitKey({ projectDir: cwd, level, kind: "permission", name }));
    approvals.revoke(grantKeyOf({ projectDir: cwd, level, name }));
  },
});
