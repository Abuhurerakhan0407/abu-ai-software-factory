import { resolve } from "node:path";
import { MissionControl } from "./mission-control/mission-control.js";
import { JsonTaskStore } from "./store/task-store.js";

const request = process.argv.slice(2).join(" ").trim();

if (!request) {
  console.log('Usage: npm run dev -- "Add attendance export"');
  process.exit(0);
}

const store = new JsonTaskStore(resolve("data/tasks.json"));
const missionControl = new MissionControl(store);

const task = await missionControl.intake({
  title: request.slice(0, 160),
  description: request,
  requestedBy: "Abu",
});

console.log(JSON.stringify({
  id: task.id,
  status: task.status,
  category: task.category,
  assignedAgent: task.assignedAgent,
  risk: task.risk,
}, null, 2));
