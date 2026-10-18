import {
  isCompleteGitRemote,
  parseGitHubRemoteUrl,
  parseGitRemoteLocation,
} from "@getpaseo/protocol/git-remote";
import { ForgejoRepositoryNameSchema, type ForgejoRepository } from "@getpaseo/protocol/messages";
import { shortenPath } from "@/utils/shorten-path";
import type { AddProjectHost, GithubRepositoryChoice } from "./model";

export type AddProjectMethodId =
  | "directory-search"
  | "browse"
  | "github"
  | "forgejo"
  | "new-directory";

export interface ForgejoRepositoryChoice {
  id: string;
  name: string;
  create: boolean;
  title: string;
  description: string | null;
}

export interface ForgejoRepositorySearch {
  host: string;
  owner: string;
  repositories: ForgejoRepository[];
}

export interface AddProjectMethodOption {
  id: AddProjectMethodId;
  label: string;
  description: string;
  disabled?: boolean;
}

export interface AddProjectPathOption {
  id: string;
  path: string;
  displayPath: string;
  secondaryText: string | null;
  disabled: boolean;
}

export function filterAddProjectHosts(hosts: AddProjectHost[], query: string): AddProjectHost[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return hosts;
  return hosts.filter(
    (host) =>
      host.label.toLowerCase().includes(normalized) ||
      host.serverId.toLowerCase().includes(normalized),
  );
}

export function buildAddProjectMethods(host: AddProjectHost): AddProjectMethodOption[] {
  if (!host.canAddProject) return [];
  const options: AddProjectMethodOption[] = [];
  options.push({
    id: "directory-search",
    label: "Search for directory",
    description: `Find a directory on ${host.label}`,
  });
  if (host.canBrowse) {
    options.push({
      id: "browse",
      label: "Browse",
      description: "Choose or create a directory in Finder",
    });
  }
  options.push({
    id: "github",
    label: "Clone from GitHub",
    description: githubMethodDescription(host),
    disabled: !host.canCloneGithubRepositories,
  });
  if (host.canCloneForgejoRepositories) {
    options.push({
      id: "forgejo",
      label: "Clone from Forgejo",
      description: "Find or create a repository on your Forgejo server",
    });
  }
  options.push({
    id: "new-directory",
    label: "New directory",
    description: host.canCreateDirectory
      ? `Create an empty directory on ${host.label}`
      : "Update this host to create directories",
    disabled: !host.canCreateDirectory,
  });
  return options;
}

/** Search results, led by a "Create" choice when the query names a repository that does not exist. */
export function buildForgejoRepositoryChoices(
  query: string,
  search: ForgejoRepositorySearch,
): ForgejoRepositoryChoice[] {
  const name = query.trim();
  const hasExactMatch = search.repositories.some(
    (repository) => repository.name.toLowerCase() === name.toLowerCase(),
  );
  const canCreate = !hasExactMatch && ForgejoRepositoryNameSchema.safeParse(name).success;
  const existing = search.repositories.map((repository) => ({
    id: repository.nameWithOwner,
    name: repository.name,
    create: false,
    title: repository.nameWithOwner,
    description: repository.description,
  }));
  if (!canCreate) return existing;
  const createChoice = {
    id: `create:${name}`,
    name,
    create: true,
    title: `Create ${search.owner}/${name}`,
    description: `New private repository on ${search.host}`,
  };
  return [createChoice, ...existing];
}

export function addProjectMethodEmptyText(host: AddProjectHost | null): string {
  return host?.canAddProject === false
    ? "Update the host to use Add Project."
    : "No matching options";
}

function githubMethodDescription(host: AddProjectHost): string {
  if (!host.canCloneGithubRepositories) {
    return "Update this host to clone GitHub repositories";
  }
  if (host.canSearchGithubRepositories) {
    return "Search projects available to your GitHub account";
  }
  return "Enter a GitHub URL or owner/repo";
}

export function pathBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

export function buildManualGithubRepositoryChoices(query: string): GithubRepositoryChoice[] {
  const repo = query.trim();
  if (!repo) return [];

  if (isCompleteGitRemote(repo)) {
    const identity = parseGitHubRemoteUrl(repo);
    const location = parseGitRemoteLocation(repo);
    const remoteName = location ? pathBaseName(location.path).replace(/\.git$/u, "") : repo;
    return [
      {
        id: `manual:${repo}`,
        nameWithOwner: identity?.repo ?? remoteName,
        cloneUrl: repo,
        description: "Clone this repository URL",
        updatedAt: null,
      },
    ];
  }

  const shorthand = repo.match(/^([^\s/]+)\/([^\s/]+)$/u);
  if (!shorthand) return [];
  const nameWithOwner = `${shorthand[1]}/${shorthand[2]}`;
  return (["https", "ssh"] as const).map((cloneProtocol) => ({
    id: `manual:${cloneProtocol}:${nameWithOwner}`,
    nameWithOwner,
    cloneUrl: nameWithOwner,
    cloneProtocol,
    description: `Clone owner/repo via ${cloneProtocol.toUpperCase()}`,
    updatedAt: null,
  }));
}

export function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return null;
  if (index === 0) return trimmed.slice(0, 1);
  return trimmed.slice(0, index);
}

export function joinDirectoryPath(parent: string, name: string): string {
  const trimmedParent = parent.replace(/[\\/]+$/, "");
  const separator = trimmedParent.includes("\\") && !trimmedParent.includes("/") ? "\\" : "/";
  return `${trimmedParent}${separator}${name}`;
}

export function buildSuggestedParentDirectories(projectPaths: string[]): string[] {
  const values = [
    ...projectPaths.flatMap((path) => {
      const parent = parentDirectory(path);
      return parent ? [parent] : [];
    }),
    "~/dev",
    "~/Developer",
    "~/src",
    "~/projects",
    "~/workspace",
    "~",
  ];
  return [...new Set(values)];
}

export function buildCloneLocationOptions(input: {
  parents: string[];
  repositoryName: string;
  existingPaths: string[];
}): AddProjectPathOption[] {
  const existing = new Set(input.existingPaths.map(pathIdentity));
  const seen = new Set<string>();
  return input.parents.flatMap((parent) => {
    const path = joinDirectoryPath(parent, input.repositoryName);
    const identity = pathIdentity(path);
    if (seen.has(identity)) return [];
    seen.add(identity);
    const pathExists = existing.has(identity);
    return [
      {
        id: parent,
        path: parent,
        displayPath: path,
        secondaryText: pathExists ? "Already exists" : `Parent directory: ${parent}`,
        disabled: pathExists,
      },
    ];
  });
}

function pathIdentity(path: string): string {
  const normalized = shortenPath(path.trim()).replace(/\\/g, "/").replace(/\/+$/u, "");
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}
