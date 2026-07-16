import { Blocker, Issue, ServiceConfig } from "./types.js";

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

const issueFields = `
  id identifier title description priority url branchName createdAt updatedAt
  state { name }
  assignee { id }
  labels { nodes { name } }
  blockedBy { nodes { id identifier state { name } } }
`;

function normalize(raw: Record<string, unknown>): Issue {
  const relationNodes = (value: unknown): Record<string, unknown>[] =>
    typeof value === "object" && value !== null && Array.isArray((value as { nodes?: unknown }).nodes)
      ? ((value as { nodes: Record<string, unknown>[] }).nodes)
      : [];
  const stateName = (value: unknown) => typeof value === "object" && value !== null ? String((value as { name?: unknown }).name ?? "") : "";
  const blockers: Blocker[] = relationNodes(raw.blockedBy).map((blocker) => ({
    id: blocker.id ? String(blocker.id) : null,
    identifier: blocker.identifier ? String(blocker.identifier) : null,
    state: stateName(blocker.state) || null,
  }));
  return {
    id: String(raw.id ?? ""),
    identifier: String(raw.identifier ?? ""),
    title: String(raw.title ?? ""),
    description: raw.description ? String(raw.description) : null,
    priority: typeof raw.priority === "number" ? raw.priority : null,
    state: stateName(raw.state),
    branchName: raw.branchName ? String(raw.branchName) : null,
    url: raw.url ? String(raw.url) : null,
    labels: relationNodes(raw.labels).map((label) => String(label.name ?? "").trim().toLowerCase()).filter(Boolean),
    blockedBy: blockers,
    createdAt: raw.createdAt ? String(raw.createdAt) : null,
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : null,
    assigneeId: typeof raw.assignee === "object" && raw.assignee !== null && (raw.assignee as { id?: unknown }).id
      ? String((raw.assignee as { id: unknown }).id)
      : null,
  };
}

export class LinearClient {
  constructor(private readonly config: ServiceConfig["tracker"]) {}

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.config.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Linear request failed: HTTP ${response.status}`);
    const body = await response.json() as GraphqlResponse<T>;
    if (body.errors?.length) throw new Error(`Linear GraphQL error: ${body.errors.map((error) => error.message ?? "unknown").join("; ")}`);
    if (!body.data) throw new Error("Linear response did not contain data");
    return body.data;
  }

  async fetchCandidates(activeStates: string[]): Promise<Issue[]> {
    const query = `query SymphonyCandidates($slug: String!, $states: [String!]!) {
      issues(first: 100, filter: { project: { slug: { eq: $slug } }, state: { name: { in: $states } } }) {
        nodes { ${issueFields} }
      }
    }`;
    const data = await this.graphql<{ issues: { nodes: Record<string, unknown>[] } }>(query, {
      slug: this.config.projectSlug,
      states: activeStates,
    });
    return data.issues.nodes.map(normalize);
  }

  async fetchStates(issueIds: string[]): Promise<Map<string, Issue>> {
    if (!issueIds.length) return new Map();
    const query = `query SymphonyStates($ids: [ID!]!) {
      issues(filter: { id: { in: $ids } }) { nodes { ${issueFields} } }
    }`;
    const data = await this.graphql<{ issues: { nodes: Record<string, unknown>[] } }>(query, { ids: issueIds });
    return new Map(data.issues.nodes.map((raw) => {
      const issue = normalize(raw);
      return [issue.id, issue];
    }));
  }

  async fetchTerminalIssues(terminalStates: string[]): Promise<Issue[]> {
    return this.fetchCandidates(terminalStates);
  }
}
