import { describe, expect, it, vi } from "vitest";
import { GitHubGateway } from "../src/github/github-gateway.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHubGateway", () => {
  it("refuses direct/default branch writes before any network call", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const gateway = new GitHubGateway(
      "abu/school-saas",
      "github/software-factory",
      "oidc-test-token",
      fetcher,
    );

    await expect(gateway.writeFile({
      branch: "main",
      path: "README.md",
      content: "unsafe",
      message: "unsafe",
    })).rejects.toThrow("factory/*");

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("lists repository trees through a scoped GitHub token", async () => {
    const responses = [
      jsonResponse({ token: "short-lived-token" }),
      jsonResponse({
        tree: [
          { path: "README.md", type: "blob", sha: "readme", size: 10 },
          { path: "src", type: "tree", sha: "src" },
        ],
        truncated: false,
      }),
    ];
    const fetcher = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const gateway = new GitHubGateway(
      "abu/school-saas",
      "github/software-factory",
      "oidc-test-token",
      fetcher,
    );

    const tree = await gateway.listTree("main");

    expect(tree.truncated).toBe(false);
    expect(tree.entries).toHaveLength(2);
    expect(String((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]))
      .toContain("/git/trees/main?recursive=1");
  });

  it("creates task-scoped factory branches", async () => {
    const responses = [
      jsonResponse({ token: "short-lived-token" }),
      jsonResponse({ default_branch: "main" }),
      jsonResponse({ object: { sha: "abc123" } }),
      jsonResponse({ ref: "refs/heads/factory/task" }, 201),
    ];
    const fetcher = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const gateway = new GitHubGateway(
      "abu/school-saas",
      "github/software-factory",
      "oidc-test-token",
      fetcher,
    );
    const taskId = "11111111-1111-4111-8111-111111111111";

    const branch = await gateway.createFactoryBranch(taskId);

    expect(branch).toBe(`factory/${taskId}`);
    const createRefCall = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[3];
    expect(String(createRefCall?.[0])).toContain("/git/refs");
    expect(JSON.parse(String(createRefCall?.[1]?.body))).toEqual({
      ref: `refs/heads/factory/${taskId}`,
      sha: "abc123",
    });
  });

  it("always opens agent pull requests as drafts", async () => {
    const responses = [
      jsonResponse({ token: "short-lived-token" }),
      jsonResponse({ default_branch: "main" }),
      jsonResponse({
        number: 42,
        html_url: "https://github.com/abu/school-saas/pull/42",
        draft: true,
      }, 201),
    ];
    const fetcher = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const gateway = new GitHubGateway(
      "abu/school-saas",
      "github/software-factory",
      "oidc-test-token",
      fetcher,
    );

    const pull = await gateway.openDraftPullRequest({
      branch: "factory/11111111-1111-4111-8111-111111111111",
      title: "Agent change",
      body: "Automated change awaiting review",
    });

    expect(pull.draft).toBe(true);
    const pullCall = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(JSON.parse(String(pullCall?.[1]?.body)).draft).toBe(true);
  });
});
