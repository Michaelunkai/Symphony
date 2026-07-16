import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ id: request.id, result: { serverInfo: { name: "fake" } } })}\n`);
  } else if (request.method === "thread/start") {
    process.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: "thread-1" } } })}\n`);
  } else if (request.method === "turn/start") {
    process.stdout.write(`${JSON.stringify({ id: request.id, result: { turn: { id: "turn-1" } } })}\n`);
    process.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } } })}\n`);
  } else if (request.id) {
    process.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
  }
}
