import path from "node:path";
import { bindWorkflowPrompt, DefaultAgentRunner } from "./agent.js";
import { LinearClient } from "./linear.js";
import { JsonLogger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { ReloadingWorkflow } from "./workflow.js";

const args = new Set(process.argv.slice(2));
const workflowIndex = process.argv.indexOf("--workflow");
const workflowPath = workflowIndex >= 0
  ? path.resolve(process.argv[workflowIndex + 1] ?? "")
  : path.resolve(process.cwd(), "WORKFLOW.md");
const logger = new JsonLogger(process.env.SYMPHONY_LOG_FILE);
const source = new ReloadingWorkflow(workflowPath, (error) => logger.log("error", "workflow_reload_failed", { error: error.message }));

const orchestrator = new Orchestrator(
  {
    fetchCandidates: async (states) => {
      const workflow = await source.get();
      return new LinearClient(workflow.serviceConfig.tracker).fetchCandidates(states);
    },
    fetchStates: async (ids) => {
      const workflow = await source.get();
      return new LinearClient(workflow.serviceConfig.tracker).fetchStates(ids);
    },
    fetchTerminalIssues: async (states) => {
      const workflow = await source.get();
      return new LinearClient(workflow.serviceConfig.tracker).fetchTerminalIssues(states);
    },
  },
  new DefaultAgentRunner(),
  async () => {
    const workflow = await source.get();
    bindWorkflowPrompt(workflow.serviceConfig, workflow.promptTemplate);
    return workflow;
  },
  logger,
);

if (args.has("--once")) {
  await orchestrator.start();
  orchestrator.stop();
} else {
  await orchestrator.start();
  const shutdown = () => {
    orchestrator.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
