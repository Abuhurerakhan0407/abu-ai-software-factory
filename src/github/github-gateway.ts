import { z } from "zod";

const RepositorySchema = z.string().regex(
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  "repository must use owner/name format",
);

const ConnectTokenSchema = z.object({
  token: z.string().min(1),
});

const RepositoryResponseSchema = z.object({
  default_branch: z.string().min(1),
});

const RefResponseSchema = z.object({
  object: z.object({ sha: z.string().min(1) }),
});

const ContentResponseSchema = z.object({
  sha: z.string().min(1),
  content: z.string(),
  encoding: z.literal("base64"),
});

const TreeResponseSchema = z.object({
  tree: z.array(z.object({
    path: z.string().min(1),
    type: z.enum(["blob", "tree", "commit"]),
    sha: z.string().min(1),
    size: z.number().int().nonnegative().optional(),
  })),
  truncated: z.boolean(),
});

const PullResponseSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  draft: z.boolean(),
});

const ProductionPullResponseSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.literal("open"),
  draft: z.boolean(),
  merged: z.boolean().default(false),
  body: z.string().nullable(),
  head: z.object({
    ref: z.string().min(1),
    sha: z.string().min(7),
    repo: z.object({ full_name: z.string().min(3) }),
  }),
  base: z.object({
    ref: z.string().min(1),
    repo: z.object({ full_name: z.string().min(3) }),
  }),
});

const MergeResponseSchema = z.object({
  sha: z.string().min(7),
  merged: z.boolean(),
  message: z.string(),
});

type Fetcher = typeof fetch;

export type GitHubFile = {
  sha: string;
  content: string;
};

export type GitHubTreeEntry = {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
};

export type GitHubTree = {
  entries: GitHubTreeEntry[];
  truncated: boolean;
};

export type DraftPullRequest = {
  number: number;
  url: string;
  draft: true;
};

export type ProductionPromotion = {
  pullRequest: number;
  url: string;
  sourceHeadSha: string;
  productionCommitSha: string;
};

export class GitHubGateway {
  constructor(
    private readonly repository: string,
    private readonly connectorId: string,
    private readonly oidcToken: string,
    private readonly fetcher: Fetcher = fetch,
  ) {
    RepositorySchema.parse(repository);
    if (!connectorId) throw new Error("GITHUB_CONNECTOR_ID is required");
    if (!oidcToken) throw new Error("VERCEL_OIDC_TOKEN is required");
  }

  private connectTokenPromise?: Promise<string>;

  async getFile(path: string, ref: string): Promise<GitHubFile> {
    const response = ContentResponseSchema.parse(await this.github(
      `/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`,
    ));
    return {
      sha: response.sha,
      content: Buffer.from(response.content.replace(/\n/g, ""), "base64").toString("utf8"),
    };
  }

  async listTree(ref: string): Promise<GitHubTree> {
    const response = TreeResponseSchema.parse(await this.github(
      `/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    ));
    return {
      entries: response.tree.map((entry) => ({
        path: entry.path,
        type: entry.type,
        sha: entry.sha,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      })),
      truncated: response.truncated,
    };
  }

  async createFactoryBranch(taskId: string): Promise<string> {
    if (!z.string().uuid().safeParse(taskId).success) throw new Error("taskId must be a UUID");

    const metadata = RepositoryResponseSchema.parse(await this.github(""));
    const ref = RefResponseSchema.parse(await this.github(
      `/git/ref/heads/${encodeURIComponent(metadata.default_branch)}`,
    ));
    const branch = `factory/${taskId}`;

    await this.github("/git/refs", {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: ref.object.sha,
      }),
    });

    return branch;
  }

  async writeFile(input: {
    branch: string;
    path: string;
    content: string;
    message: string;
    sha?: string;
  }): Promise<void> {
    this.assertFactoryBranch(input.branch);

    await this.github(
      `/contents/${encodeURIComponent(input.path).replace(/%2F/g, "/")}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: input.message,
          content: Buffer.from(input.content, "utf8").toString("base64"),
          branch: input.branch,
          ...(input.sha ? { sha: input.sha } : {}),
        }),
      },
    );
  }

  async openDraftPullRequest(input: {
    branch: string;
    title: string;
    body: string;
  }): Promise<DraftPullRequest> {
    this.assertFactoryBranch(input.branch);
    const metadata = RepositoryResponseSchema.parse(await this.github(""));

    const pull = PullResponseSchema.parse(await this.github("/pulls", {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.branch,
        base: metadata.default_branch,
        draft: true,
      }),
    }));

    if (!pull.draft) throw new Error("GitHub returned a non-draft pull request");
    return { number: pull.number, url: pull.html_url, draft: true };
  }

  async promoteVerifiedFactoryPullRequest(input: {
    pullRequest: number;
    productionBranch: string;
  }): Promise<ProductionPromotion> {
    if (!Number.isInteger(input.pullRequest) || input.pullRequest < 1) {
      throw new Error("Pull request number is invalid");
    }
    if (!/^[A-Za-z0-9._/-]{1,120}$/.test(input.productionBranch)) {
      throw new Error("Production branch is invalid");
    }

    const pull = ProductionPullResponseSchema.parse(
      await this.github(`/pulls/${input.pullRequest}`),
    );
    const body = pull.body ?? "";
    const verifiedBody = body.includes("Sandbox verification:")
      && body.includes("QA/security review:")
      && body.includes("Safety: draft PR only; protected paths rejected; production unchanged.");

    if (
      pull.draft
      || pull.merged
      || pull.base.ref !== input.productionBranch
      || pull.base.repo.full_name !== this.repository
      || pull.head.repo.full_name !== this.repository
      || !pull.head.ref.startsWith("factory/")
      || !verifiedBody
    ) {
      throw new Error("Pull request is outside verified production policy");
    }

    const merge = MergeResponseSchema.parse(await this.github(
      `/pulls/${input.pullRequest}/merge`,
      {
        method: "PUT",
        body: JSON.stringify({
          sha: pull.head.sha,
          merge_method: "squash",
        }),
      },
    ));
    if (!merge.merged) {
      throw new Error("GitHub rejected production merge: " + merge.message);
    }

    return {
      pullRequest: pull.number,
      url: pull.html_url,
      sourceHeadSha: pull.head.sha,
      productionCommitSha: merge.sha,
    };
  }

  private assertFactoryBranch(branch: string): void {
    if (!branch.startsWith("factory/")) {
      throw new Error("Agent writes require a factory/* branch");
    }
    if (branch === "main" || branch === "master") {
      throw new Error("Direct default-branch writes are forbidden");
    }
  }

  private async github(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.connectToken();
    const response = await this.fetcher(
      `https://api.github.com/repos/${this.repository}${path}`,
      {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...init.headers,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub request failed with status ${response.status}`);
    }
    return response.status === 204 ? {} : response.json();
  }

  private connectToken(): Promise<string> {
    this.connectTokenPromise ??= this.requestConnectToken();
    return this.connectTokenPromise;
  }

  private async requestConnectToken(): Promise<string> {
    const response = await this.fetcher(
      `https://api.vercel.com/v1/connect/token/${this.connectorId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.oidcToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ subject: { type: "app" } }),
      },
    );

    if (!response.ok) {
      throw new Error(`Vercel Connect token exchange failed with status ${response.status}`);
    }

    return ConnectTokenSchema.parse(await response.json()).token;
  }
}

export function getProductionGitHubGateway(repository: string): GitHubGateway {
  return new GitHubGateway(
    repository,
    process.env.GITHUB_CONNECTOR_ID ?? "",
    process.env.VERCEL_OIDC_TOKEN ?? "",
  );
}
