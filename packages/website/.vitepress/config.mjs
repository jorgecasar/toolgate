import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const docsDir = path.join(repoRoot, "docs");
const site = JSON.parse(fs.readFileSync(path.join(here, "..", "site.config.json"), "utf8"));

// The base path and the repository URL are settings, not code: a new repository or a custom domain is a different value.
const withSlashes = (base) => `/${base.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
const base = withSlashes(process.env.SITE_BASE || site.base);
const repoUrl = (process.env.SITE_REPO_URL || site.repoUrl).replace(/\/+$/, "");

// The working notes are not on the site (srcExclude).
const NOT_ON_SITE = ["tasks", "adr"];
const onSite = (file) => file.startsWith(docsDir + path.sep) && !NOT_ON_SITE.some((dir) => file.startsWith(path.join(docsDir, dir) + path.sep));

// A link from a doc to a file the site does not have (outside docs/, or a working note: ../README.md, ../packages/…, ./adr/…) stays
// relative in the doc, so it works on GitHub. On the site it points at the file in the repository. A file that is not in the
// repository is an error, like any dead link.
function repoLinks(md) {
  md.core.ruler.push("toolgate_repo_links", (state) => {
    const page = state.env?.path;
    if (!page) return;
    for (const block of state.tokens) {
      // The install text names the repository in a command: it follows the configured URL too.
      if (block.type === "fence") block.content = block.content.replaceAll(site.repoUrl, repoUrl);
      for (const token of block.children ?? []) {
        if (token.type !== "link_open") continue;
        const href = token.attrGet("href") ?? "";
        if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) continue;
        const [target, hash = ""] = href.split("#");
        const file = path.resolve(path.dirname(page), decodeURIComponent(target));
        if (file === docsDir || onSite(file)) continue;
        const relative = path.relative(repoRoot, file);
        if (relative.startsWith("..")) throw new Error(`${path.relative(repoRoot, page)}: the link ${href} leaves the repository`);
        const found = [file, `${file}.md`].find((candidate) => fs.existsSync(candidate));
        if (found === undefined) throw new Error(`${path.relative(repoRoot, page)}: the link ${href} names a file that is not in the repository`);
        token.attrSet("href", `${repoUrl}/blob/${site.branch}/${path.relative(repoRoot, found).split(path.sep).join("/")}${hash ? `#${hash}` : ""}`);
      }
    }
  });
}

export default defineConfig({
  srcDir: "../../docs",
  srcExclude: ["tasks/**", "adr/**"],
  cleanUrls: true,
  lang: "en",
  title: "toolgate",
  description: "A gate in front of your agent's context: only what the task needs passes through.",
  base,
  markdown: { config: repoLinks },
  themeConfig: {
    search: { provider: "local" },
    nav: [
      { text: "Get started", link: "/getting-started" },
      { text: "How it works", link: "/DESIGN" },
      { text: "Agents", link: "/agents" },
      { text: "Reference", link: "/recommended-skills" },
    ],
    socialLinks: [{ icon: "github", link: repoUrl }],
    sidebar: [
      { text: "Get started", items: [{ text: "From an empty project to a working setup", link: "/getting-started" }] },
      {
        text: "How it works",
        items: [
          { text: "Design", link: "/DESIGN" },
          { text: "The qmd daemon and the skills index", link: "/qmd-integration" },
          { text: "Dynamic activation and routing", link: "/SPEC-dynamic-activation-and-routing" },
        ],
      },
      {
        text: "Agents",
        items: [
          { text: "What each agent supports", link: "/agents" },
          { text: "Adapters", link: "/ADAPTERS" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Configuration", link: "/getting-started#configuration" },
          { text: "Day to day", link: "/getting-started#day-to-day" },
          { text: "Check it works (doctor)", link: "/getting-started#_4-check-it-works" },
          { text: "Security considerations", link: "/DESIGN#security-considerations" },
          { text: "Recommended skills", link: "/recommended-skills" },
        ],
      },
    ],
  },
});
