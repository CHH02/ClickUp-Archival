import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const taskId = process.env.CLICKUP_TASK_ID;
const eventType = process.env.CLICKUP_EVENT_TYPE ?? "unknown";
const webhookId = process.env.CLICKUP_WEBHOOK_ID ?? "unknown";
const historyId = process.env.CLICKUP_HISTORY_ID ?? "none";
const clickupToken = process.env.CLICKUP_API_TOKEN;

if (!taskId) {
  throw new Error("CLICKUP_TASK_ID is required.");
}

if (!clickupToken) {
  throw new Error("CLICKUP_API_TOKEN is required.");
}

const response = await fetch(
  `https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}`,
  {
    headers: {
      Authorization: clickupToken,
      "Content-Type": "application/json"
    }
  }
);

const now = new Date();
const timestamp = now.toISOString();

const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
const taskDirectory = path.join("archive", "tasks", safeTaskId);
const eventDirectory = path.join("archive", "events", safeTaskId);

await fs.mkdir(taskDirectory, { recursive: true });
await fs.mkdir(eventDirectory, { recursive: true });

if (response.status === 404) {
  const deletedDirectory = path.join("archive", "deleted");
  await fs.mkdir(deletedDirectory, { recursive: true });

  const deletedRecord = {
    task_id: taskId,
    detected_at: timestamp,
    triggering_event: eventType,
    webhook_id: webhookId,
    history_id: historyId
  };

  await fs.writeFile(
    path.join(deletedDirectory, `${safeTaskId}.json`),
    JSON.stringify(deletedRecord, null, 2) + "\n"
  );

  console.log(`Recorded deleted or unavailable task ${taskId}`);
  process.exit(0);
}

if (!response.ok) {
  const text = await response.text();
  throw new Error(
    `ClickUp API returned ${response.status}: ${text.slice(0, 500)}`
  );
}

const rawTask = await response.json();

/*
 * Archive only fields that the team has approved.
 * Add or remove fields after reviewing confidentiality requirements.
 */
const normalizedTask = {
  schema_version: "1.0",
  archived_at: timestamp,
  source: {
    system: "ClickUp",
    task_id: rawTask.id,
    custom_id: rawTask.custom_id ?? null,
    url: rawTask.url ?? null,
    webhook_id: webhookId,
    history_id: historyId,
    triggering_event: eventType
  },
  task: {
    name: rawTask.name ?? null,
    description: rawTask.description ?? null,
    text_content: rawTask.text_content ?? null,
    status: rawTask.status
      ? {
          name: rawTask.status.status,
          type: rawTask.status.type,
          color: rawTask.status.color
        }
      : null,
    priority: rawTask.priority
      ? {
          name: rawTask.priority.priority,
          order_index: rawTask.priority.orderindex
        }
      : null,
    date_created: rawTask.date_created ?? null,
    date_updated: rawTask.date_updated ?? null,
    start_date: rawTask.start_date ?? null,
    due_date: rawTask.due_date ?? null,
    parent: rawTask.parent ?? null,
    list: rawTask.list
      ? {
          id: rawTask.list.id,
          name: rawTask.list.name
        }
      : null,
    folder: rawTask.folder
      ? {
          id: rawTask.folder.id,
          name: rawTask.folder.name
        }
      : null,
    space: rawTask.space
      ? {
          id: rawTask.space.id
        }
      : null,
    tags: Array.isArray(rawTask.tags)
      ? rawTask.tags.map(tag => ({
          name: tag.name,
          tag_fg: tag.tag_fg,
          tag_bg: tag.tag_bg
        }))
      : [],
    assignees: Array.isArray(rawTask.assignees)
      ? rawTask.assignees.map(person => ({
          id: person.id,
          username: person.username
        }))
      : [],
    dependencies: rawTask.dependencies ?? [],
    custom_fields: Array.isArray(rawTask.custom_fields)
      ? rawTask.custom_fields.map(field => ({
          id: field.id,
          name: field.name,
          type: field.type,
          value: field.value ?? null
        }))
      : []
  }
};

const canonicalJson = JSON.stringify(
  normalizedTask.task,
  Object.keys(normalizedTask.task).sort()
);

normalizedTask.content_sha256 = crypto
  .createHash("sha256")
  .update(canonicalJson)
  .digest("hex");

const currentJsonPath = path.join(taskDirectory, "current.json");

await fs.writeFile(
  currentJsonPath,
  JSON.stringify(normalizedTask, null, 2) + "\n"
);

const markdown = `# ${normalizedTask.task.name ?? taskId}

- **ClickUp task ID:** ${taskId}
- **Status:** ${normalizedTask.task.status?.name ?? "Unknown"}
- **Priority:** ${normalizedTask.task.priority?.name ?? "None"}
- **List:** ${normalizedTask.task.list?.name ?? "Unknown"}
- **Folder:** ${normalizedTask.task.folder?.name ?? "Unknown"}
- **Due date:** ${normalizedTask.task.due_date ?? "None"}
- **Last archived:** ${timestamp}
- **Content hash:** ${normalizedTask.content_sha256}

## Description

${normalizedTask.task.text_content || "No description provided."}

## Source

${normalizedTask.source.url || "No source URL available."}
`;

await fs.writeFile(
  path.join(taskDirectory, "current.md"),
  markdown
);

/*
 * Event files are append-only evidence that the webhook occurred.
 */
const eventKey = `${webhookId}-${historyId}-${eventType}`
  .replace(/[^a-zA-Z0-9_-]/g, "_");

const eventRecord = {
  event_key: eventKey,
  received_by_action_at: timestamp,
  event_type: eventType,
  task_id: taskId,
  webhook_id: webhookId,
  history_id: historyId,
  resulting_content_sha256: normalizedTask.content_sha256
};

await fs.writeFile(
  path.join(eventDirectory, `${eventKey}.json`),
  JSON.stringify(eventRecord, null, 2) + "\n"
);

console.log(`Archived task ${taskId}`);