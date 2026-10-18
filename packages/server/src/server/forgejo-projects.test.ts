import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CloneCommandOutputError,
  createForgejoProjects,
  ForgejoLoginMissingError,
  ForgejoRepositoryNotFoundError,
} from "./forgejo-projects.js";
import type { TeaCommandRunner } from "../services/gitea-service.js";

const LOGINS = JSON.stringify([
  {
    name: "work",
    url: "https://forgejo.example.com",
    ssh_host: "forgejo.example.com",
    user: "alice",
  },
]);

interface FakeRepository {
  name: string;
  updated: string;
  /** Another owner. The search for an owner also returns the repositories that it collaborates on. */
  owner?: string;
}

function createFakeTea(existing: FakeRepository[]) {
  const calls: string[][] = [];
  const runTea: TeaCommandRunner = async (args) => {
    calls.push(args);
    if (args[0] === "login") return { stdout: LOGINS, stderr: "" };
    if (args[1] === "create") {
      existing.push({ name: args[args.indexOf("--name") + 1]!, updated: "2026-10-18T00:00:00Z" });
      return { stdout: "created", stderr: "" };
    }
    const query = args[args.length - 1]!;
    const searchedOwner = args[args.indexOf("--owner") + 1]!;
    const fields = args[args.indexOf("--fields") + 1]!.split(",");
    const matches = existing
      .filter((repository) => repository.name.includes(query))
      .map((repository) => {
        const owner = repository.owner ?? searchedOwner;
        const row: Record<string, string> = {
          name: repository.name,
          owner,
          description: "",
          ssh: `ssh://git@forgejo.example.com:2222/${owner}/${repository.name}.git`,
          url: `https://forgejo.example.com/${owner}/${repository.name}`,
          updated: repository.updated,
        };
        return Object.fromEntries(fields.map((field) => [field, row[field]]));
      });
    return { stdout: JSON.stringify(matches), stderr: "" };
  };
  return { runTea, calls };
}

describe("Forgejo projects", () => {
  let checkoutRoot: string;
  const cloned: string[][] = [];

  beforeEach(async () => {
    checkoutRoot = await mkdtemp(join(tmpdir(), "paseo-forgejo-"));
    cloned.length = 0;
  });

  afterEach(async () => {
    await rm(checkoutRoot, { recursive: true, force: true });
  });

  function create(input: { owner: string; existing: FakeRepository[]; cloneOutput?: string }) {
    const tea = createFakeTea(input.existing);
    const repositories = createForgejoProjects(
      { host: "forgejo.example.com", owner: input.owner, cloneCommand: ["clone", "--quiet"] },
      {
        runTea: tea.runTea,
        runCloneCommand: async (command) => {
          cloned.push(command);
          return input.cloneOutput ?? `Cloning into place\n${checkoutRoot}\n`;
        },
      },
    );
    return { repositories, calls: tea.calls };
  }

  it("lists the owner's repositories through the matching tea login, recent first", async () => {
    const { repositories, calls } = create({
      owner: "team",
      existing: [
        { name: "old", updated: "2026-01-01T00:00:00Z" },
        { name: "new", updated: "2026-10-01T00:00:00Z" },
      ],
    });

    const found = await repositories.search("");

    expect(found.map((repository) => repository.nameWithOwner)).toEqual(["team/new", "team/old"]);
    expect(found[0]).toEqual({
      name: "new",
      nameWithOwner: "team/new",
      description: null,
      updatedAt: "2026-10-01T00:00:00Z",
    });
    const search = calls.find((args) => args[1] === "search")!;
    expect(search.slice(0, 6)).toEqual(["repos", "search", "--login", "work", "--owner", "team"]);
    expect(search.slice(-2)).toEqual(["--", ""]);
  });

  it("lists only the repositories that the owner owns", async () => {
    const { repositories } = create({
      owner: "Team",
      existing: [
        { name: "app", owner: "team", updated: "2026-10-01T00:00:00Z" },
        { name: "shared", owner: "other-org", updated: "2026-10-02T00:00:00Z" },
      ],
    });

    const found = await repositories.search("");

    expect(found.map((repository) => repository.nameWithOwner)).toEqual(["team/app"]);
  });

  it("clones an existing repository with the configured command and its SSH URL", async () => {
    const { repositories, calls } = create({
      owner: "team",
      existing: [
        { name: "app", updated: "2026-10-01T00:00:00Z" },
        { name: "app-docs", updated: "2026-10-02T00:00:00Z" },
      ],
    });

    await expect(repositories.checkout({ name: "app", create: true })).resolves.toBe(checkoutRoot);
    expect(calls.some((args) => args[1] === "create")).toBe(false);
    expect(cloned).toEqual([
      ["clone", "--quiet", "ssh://git@forgejo.example.com:2222/team/app.git"],
    ]);
  });

  it("creates a missing repository under an organization owner", async () => {
    const { repositories, calls } = create({ owner: "team", existing: [] });

    await repositories.checkout({ name: "fresh", create: true });

    expect(calls).toContainEqual([
      "repos",
      "create",
      "--login",
      "work",
      "--owner",
      "team",
      "--name",
      "fresh",
      "--private",
    ]);
  });

  // tea's --owner always targets the organization endpoint, which refuses a user account.
  it("creates a missing repository for the login's own user without --owner", async () => {
    const { repositories, calls } = create({ owner: "Alice", existing: [] });

    await repositories.checkout({ name: "fresh", create: true });

    expect(calls).toContainEqual([
      "repos",
      "create",
      "--login",
      "work",
      "--name",
      "fresh",
      "--private",
    ]);
  });

  it("creates the owner's repository when only another owner has that name", async () => {
    const { repositories, calls } = create({
      owner: "alice",
      existing: [{ name: "app", owner: "other-org", updated: "2026-10-01T00:00:00Z" }],
    });

    await repositories.checkout({ name: "app", create: true });

    expect(calls.some((args) => args[1] === "create")).toBe(true);
    expect(cloned).toEqual([
      ["clone", "--quiet", "ssh://git@forgejo.example.com:2222/alice/app.git"],
    ]);
  });

  it("refuses a missing repository when creation was not requested", async () => {
    const { repositories, calls } = create({ owner: "team", existing: [] });

    await expect(repositories.checkout({ name: "ghost", create: false })).rejects.toBeInstanceOf(
      ForgejoRepositoryNotFoundError,
    );
    expect(calls.some((args) => args[1] === "create")).toBe(false);
  });

  it("refuses clone output that does not end with an existing directory", async () => {
    const { repositories } = create({
      owner: "team",
      existing: [{ name: "app", updated: "2026-10-01T00:00:00Z" }],
      cloneOutput: "done\n",
    });

    await expect(repositories.checkout({ name: "app", create: false })).rejects.toBeInstanceOf(
      CloneCommandOutputError,
    );
  });

  it("refuses clone output that ends with an absolute path that does not exist", async () => {
    const { repositories } = create({
      owner: "team",
      existing: [{ name: "app", updated: "2026-10-01T00:00:00Z" }],
      cloneOutput: `${join(checkoutRoot, "missing")}\n`,
    });

    await expect(repositories.checkout({ name: "app", create: false })).rejects.toBeInstanceOf(
      CloneCommandOutputError,
    );
  });

  it("explains a host without a tea login", async () => {
    const repositories = createForgejoProjects(
      { host: "other.example.com", owner: "team", cloneCommand: ["clone"] },
      { runTea: createFakeTea([]).runTea, runCloneCommand: async () => "" },
    );

    await expect(repositories.search("")).rejects.toBeInstanceOf(ForgejoLoginMissingError);
  });
});
