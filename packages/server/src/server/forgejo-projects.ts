import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ForgejoRepository } from "@getpaseo/protocol/messages";
import type { ForgejoProjectsConfig } from "./persisted-config.js";
import { execCommand } from "../utils/spawn.js";
import {
  findTeaLoginForHost,
  runTeaCommand,
  TeaCommandError,
  type TeaCommandRunner,
  type TeaLogin,
} from "../services/gitea-service.js";

const SEARCH_LIMIT = "50";
const CLONE_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

const TeaRepositorySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  ssh: z.string(),
  url: z.string(),
  updated: z.string(),
});
type TeaRepository = z.infer<typeof TeaRepositorySchema>;

export class ForgejoLoginMissingError extends Error {
  constructor(readonly host: string) {
    super(`tea has no login for ${host}. Run tea login add on the daemon host.`);
    this.name = "ForgejoLoginMissingError";
  }
}

export class ForgejoRepositoryNotFoundError extends Error {
  constructor(
    readonly nameWithOwner: string,
    readonly host: string,
  ) {
    super(`${nameWithOwner} does not exist on ${host}`);
    this.name = "ForgejoRepositoryNotFoundError";
  }
}

export class CloneCommandOutputError extends Error {
  constructor(readonly lastLine: string) {
    super(`The clone command must print the checkout directory last, but printed "${lastLine}"`);
    this.name = "CloneCommandOutputError";
  }
}

/** The text shown in the Add project dialog for a failed search or checkout. */
export function describeForgejoProjectsError(error: unknown): string {
  if (error instanceof TeaCommandError && error.stderr.trim()) return error.stderr.trim();
  if (error instanceof Error) return error.message;
  return "Forgejo request failed";
}

/** Runs the clone command (argv) and returns its stdout. */
export type CloneCommandRunner = (command: [string, ...string[]]) => Promise<string>;

export interface ForgejoProjects {
  host: string;
  owner: string;
  search(query: string): Promise<ForgejoRepository[]>;
  /** Clones the repository, creating it first when asked, and returns the checkout directory. */
  checkout(input: { name: string; create: boolean }): Promise<string>;
}

export interface CreateForgejoProjectsOptions {
  runTea?: TeaCommandRunner;
  runCloneCommand?: CloneCommandRunner;
}

async function runCloneCommand([command, ...args]: [string, ...string[]]): Promise<string> {
  const { stdout } = await execCommand(command, args, {
    cwd: homedir(),
    timeout: CLONE_COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

async function parseCheckoutDirectory(stdout: string): Promise<string> {
  const lines = stdout.split("\n").map((line) => line.trim());
  const lastLine = lines.findLast((line) => line.length > 0) ?? "";
  if (!isAbsolute(lastLine)) throw new CloneCommandOutputError(lastLine);
  const stats = await stat(lastLine).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stats?.isDirectory()) throw new CloneCommandOutputError(lastLine);
  return lastLine;
}

export function createForgejoProjects(
  config: ForgejoProjectsConfig,
  options: CreateForgejoProjectsOptions = {},
): ForgejoProjects {
  const runTea = options.runTea ?? runTeaCommand;
  const cloneRepository = options.runCloneCommand ?? runCloneCommand;

  async function tea(args: string[]): Promise<string> {
    const { stdout } = await runTea(args, { cwd: homedir() });
    return stdout;
  }

  async function resolveLogin(): Promise<TeaLogin> {
    const login = findTeaLoginForHost(await tea(["login", "list", "-o", "json"]), config.host);
    if (!login) throw new ForgejoLoginMissingError(config.host);
    return login;
  }

  async function searchTea(login: TeaLogin, query: string): Promise<TeaRepository[]> {
    const stdout = await tea([
      "repos",
      "search",
      "--login",
      login.name,
      "--owner",
      config.owner,
      "--limit",
      SEARCH_LIMIT,
      "--fields",
      "name,description,ssh,url,updated",
      "--output",
      "json",
      "--",
      query,
    ]);
    const repositories = z.array(TeaRepositorySchema).parse(JSON.parse(stdout));
    return repositories.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  async function find(login: TeaLogin, name: string): Promise<TeaRepository | undefined> {
    const repositories = await searchTea(login, name);
    return repositories.find((repository) => repository.name.toLowerCase() === name.toLowerCase());
  }

  async function createRepository(login: TeaLogin, name: string): Promise<void> {
    // `tea repos create --owner` always uses the organization endpoint, which refuses a user.
    const isLoginUser = login.user?.toLowerCase() === config.owner.toLowerCase();
    const ownerArgs = isLoginUser ? [] : ["--owner", config.owner];
    await tea([
      "repos",
      "create",
      "--login",
      login.name,
      ...ownerArgs,
      "--name",
      name,
      "--private",
    ]);
  }

  return {
    host: config.host,
    owner: config.owner,
    async search(query) {
      const repositories = await searchTea(await resolveLogin(), query);
      return repositories.map((repository) => ({
        name: repository.name,
        nameWithOwner: `${config.owner}/${repository.name}`,
        description: repository.description || null,
        updatedAt: repository.updated,
      }));
    },
    async checkout({ name, create }) {
      const login = await resolveLogin();
      let repository = await find(login, name);
      if (!repository && create) {
        await createRepository(login, name);
        repository = await find(login, name);
      }
      if (!repository) {
        throw new ForgejoRepositoryNotFoundError(`${config.owner}/${name}`, config.host);
      }
      const cloneUrl = repository.ssh || repository.url;
      return parseCheckoutDirectory(await cloneRepository([...config.cloneCommand, cloneUrl]));
    },
  };
}
