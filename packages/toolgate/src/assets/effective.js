// `toolgate hooks|permissions status --effective`: what the next launch of each adapter passes on, read from the same
// `launchPlan` the launch uses, so it cannot say what the launch does not do. Nothing here writes anything.
import { launchPlan } from "../hooks/effective.js";
import { printable } from "./common.js";

const passesOf = (noun, plan) => {
  if (!plan.applies || plan.error) return null;
  if (noun === "hook") return plan.takesHooks ? plan.preview.hooks ?? {} : null;
  if (plan.takesEnv) return plan.env;
  return plan.takesPermissions ? plan.preview.permissions ?? {} : null;
};

/** One adapter's entry: the capability, what is passed, what is held back and what the adapter cannot express. */
export function effectiveEntry(noun, name, adapterModule, { config, cwd, env }) {
  const plan = launchPlan({ adapterModule, config, cwd, env, inspect: noun === "permission" });
  const kind = noun === "hook" ? plan.hooksKind : plan.permissionsKind;
  const effective = plan.effective;
  return {
    name,
    capability: kind,
    passes: passesOf(noun, plan),
    hooks: noun === "hook" && plan.takesHooks && effective ? effective.hooks : [],
    permissions: noun === "permission" && effective && (plan.takesPermissions || plan.takesEnv) ? effective.permissions : null,
    held: (effective?.pending ?? []).filter((p) => p.kind === noun),
    problems: [...(effective?.problems ?? []), ...(plan.error ? [`not read: ${plan.error}`] : [])],
    unmapped: noun === "permission" ? plan.unmapped : [],
    note: plan.note,
    // The deny rules installed for an adapter that applies no permissions: they protect nothing there.
    lostDeny: noun === "permission" && !plan.applies ? effective?.permissions.deny.length ?? 0 : 0,
    applies: noun === "hook" ? plan.takesHooks : plan.takesPermissions || plan.takesEnv,
  };
}

const jsonEntry = ({ hooks, permissions, ...rest }) => rest;

export function effectiveJson(entries) {
  return { adapters: entries.map(jsonEntry) };
}

/** A unit that was rejected (invalid, or its name used at two levels): `--check` exits 1 for it. */
export const effectiveRejected = (entries) => entries.some((e) => e.problems.length > 0);

/** Held back, or a deny/ask rule that an adapter cannot express: `--check` exits 2 for it. */
export function effectiveBlocked(entries) {
  return entries.some((e) => e.held.length > 0 || e.lostDeny > 0 || e.unmapped.some((u) => u.list !== "allow"));
}

export function effectiveText(noun, entries) {
  const lines = [];
  for (const e of entries) {
    lines.push(`effective for ${printable(e.name)} (${noun}s: ${e.capability}):`);
    if (e.lostDeny) lines.push(`  cannot apply: ${e.lostDeny} deny rule${e.lostDeny === 1 ? "" : "s"} DENY NOT APPLIED (permissions: ${e.capability})`);
    if (!e.applies) lines.push(`  nothing is passed${e.capability === "unknown" ? " (not verified for this agent)" : ""}`);
    else if (noun === "hook") {
      for (const hook of e.hooks) {
        for (const h of hook.handlers) {
          lines.push(`  passes: ${printable(h.event)}${h.matcher === undefined ? "" : ` [${printable(h.matcher)}]`} ${[h.command, ...(h.args ?? [])].map((x) => printable(String(x))).join(" ")} (unit ${printable(hook.name)}, ${hook.level})`);
        }
      }
      if (!e.hooks.length) lines.push("  nothing is passed");
    } else {
      for (const list of ["deny", "ask", "allow"]) {
        for (const rule of e.permissions[list]) lines.push(`  ${list}${list === "allow" ? " (granted)" : ""}: ${printable(rule)}`);
      }
      if (e.passes && e.capability === "configEnv" && e.passes.OPENCODE_CONFIG_CONTENT) lines.push(`  OPENCODE_CONFIG_CONTENT: ${printable(e.passes.OPENCODE_CONFIG_CONTENT)}`);
      if (!["deny", "ask", "allow"].some((list) => e.permissions[list].length)) lines.push("  nothing is passed");
    }
    for (const u of e.unmapped) lines.push(`  cannot express: ${printable(u.rule)} [${u.list}]${u.list === "deny" ? " DENY NOT APPLIED" : ""}: ${printable(u.reason)}`);
    if (e.note) lines.push(`  note: ${printable(e.note)}`);
    for (const p of e.held) lines.push(`  held back: ${printable(p.name)} (${p.level}): ${printable(p.reason)} -> toolgate ${noun}s review${noun === "permission" ? " [--grant]" : ""}`);
    for (const problem of e.problems) lines.push(`  not applied: ${printable(problem)}`);
  }
  return lines.join("\n");
}
