import { confirm, input, select } from "@inquirer/prompts";
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { Credentials } from "../config/credentials.js";
import { request, UnderstudyApiError } from "../internal/http.js";
import { ProjectSchema, type Project } from "../internal/projects.js";

export function codingProjectIdentity(identity: string) {
  const normalized = identity.trim().toLowerCase();
  const label = stripVTControlCharacters(normalized.split("@")[0]!).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
  const stem = label.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "user";
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  return { slug: `coding-${stem}-${suffix}`, name: `Coding — ${label.slice(0, 80) || "user"}` };
}

export async function chooseCodingProject(org: string, credentials: Credentials, projects: Project[], supplied?: string, deps = {
  interactive: Boolean(process.stdin.isTTY),
  select: (choices: { name: string; value: string }[]) => select({ message: "Project", choices }),
  identity: () => input({ message: "Your name or email for a dedicated coding project", validate: value => value.trim().length > 0 || "Enter a name or email." }),
  confirm: (name: string, slug: string) => confirm({ message: `Create ${name} (${slug}) in this organization? Its name is visible to other organization members.`, default: false }),
  create: async (project: { name: string; slug: string }) => (await request({ orgId: org, url: `/admin/v1/orgs/${encodeURIComponent(org)}/projects`, method: "POST", body: project }, ProjectSchema)).data,
}): Promise<string | undefined> {
  if (supplied) {
    if (!projects.some(project => project.slug === supplied)) throw new Error("Project: selection is not available.");
    return supplied;
  }
  if (!deps.interactive) throw new Error("Supply --project in noninteractive mode. Create a dedicated coding project interactively with orchestra claude-setup.");
  const identity = credentials.email;
  const recommended = identity ? codingProjectIdentity(identity) : undefined;
  const existing = recommended && projects.find(project => project.slug === recommended.slug);
  const choice = await deps.select([
    existing
      ? { name: `Use ${existing.name ?? existing.slug} (your coding project; recommended)`, value: existing.slug }
      : { name: `Create ${recommended?.name ?? "your dedicated coding project"} (recommended)`, value: "__create__" },
    ...projects.filter(project => project.slug !== existing?.slug).map(project => ({ name: `${project.name ?? project.slug} (${project.slug})`, value: project.slug })),
  ]);
  if (choice !== "__create__") return choice;
  const proposed = recommended ?? codingProjectIdentity(await deps.identity());
  const matching = projects.find(project => project.slug === proposed.slug);
  if (matching) return matching.slug;
  if (!await deps.confirm(proposed.name, proposed.slug)) return;
  try {
    return (await deps.create(proposed)).slug;
  } catch (error) {
    if (error instanceof UnderstudyApiError && error.status === 409) throw new Error("This coding project was just created. Run orchestra claude-setup again to select it.");
    if (error instanceof UnderstudyApiError && error.status === 403) throw new Error("Your organization does not allow you to create projects. Ask an administrator to create it, or rerun setup and select an existing project.");
    throw error;
  }
}
