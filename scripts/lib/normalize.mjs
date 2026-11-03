import {
  cleanUndefined,
  stableSortObject
} from "./utilities.mjs";

export function normalizeWorkspace(workspace) {
  return stableSortObject(
    cleanUndefined({
      schema_version: "1.0",
      object_type: "workspace",
      id: stringOrNull(workspace.id),
      name: workspace.name ?? null,
      color: workspace.color ?? null
    })
  );
}

export function normalizeSpace(
  space,
  workspaceId
) {
  return stableSortObject(
    cleanUndefined({
      schema_version: "1.0",
      object_type: "space",

      id: stringOrNull(space.id),
      workspace_id: stringOrNull(workspaceId),

      name: space.name ?? null,
      private: space.private ?? null,
      archived: space.archived ?? null,

      statuses: normalizeStatuses(space.statuses),
      multiple_assignees:
        space.multiple_assignees ?? null,

      features: space.features ?? {}
    })
  );
}

export function normalizeFolder(
  folder,
  {
    workspaceId,
    spaceId
  }
) {
  return stableSortObject(
    cleanUndefined({
      schema_version: "1.0",
      object_type:
        getParentFolderId(folder)
          ? "subfolder"
          : "folder",

      id: stringOrNull(folder.id),
      workspace_id: stringOrNull(workspaceId),
      space_id: stringOrNull(spaceId),

      parent_folder_id:
        getParentFolderId(folder),

      name: folder.name ?? null,
      hidden: folder.hidden ?? null,
      archived: folder.archived ?? null,

      statuses: normalizeStatuses(folder.statuses)
    })
  );
}

export function normalizeList(
  list,
  {
    workspaceId,
    spaceId,
    folderId
  }
) {
  return stableSortObject(
    cleanUndefined({
      schema_version: "1.0",
      object_type: "list",

      id: stringOrNull(list.id),
      workspace_id: stringOrNull(workspaceId),
      space_id: stringOrNull(spaceId),
      folder_id: stringOrNull(folderId),

      name: list.name ?? null,
      content: list.content ?? null,
      archived: list.archived ?? null,

      status: list.status
        ? normalizeStatus(list.status)
        : null,

      statuses: normalizeStatuses(list.statuses),

      due_date: list.due_date ?? null,
      due_date_time: list.due_date_time ?? null,
      start_date: list.start_date ?? null,
      start_date_time: list.start_date_time ?? null,

      priority: list.priority
        ? normalizePriority(list.priority)
        : null,

      assignee: list.assignee
        ? normalizeUser(list.assignee)
        : null
    })
  );
}

export function normalizeTask(
  task,
  {
    workspaceId,
    spaceId,
    folderId,
    listId
  }
) {
  return stableSortObject(
    cleanUndefined({
      schema_version: "1.0",

      object_type:
        task.parent != null
          ? "subtask"
          : "task",

      id: stringOrNull(task.id),
      custom_id: task.custom_id ?? null,

      workspace_id: stringOrNull(workspaceId),
      space_id: stringOrNull(spaceId),
      folder_id: stringOrNull(folderId),
      list_id: stringOrNull(listId),

      parent_task_id:
        stringOrNull(task.parent),

      name: task.name ?? null,
      description: task.description ?? null,
      text_content: task.text_content ?? null,

      status: task.status
        ? normalizeStatus(task.status)
        : null,

      priority: task.priority
        ? normalizePriority(task.priority)
        : null,

      archived: task.archived ?? null,

      date_created: task.date_created ?? null,
      date_updated: task.date_updated ?? null,
      date_closed: task.date_closed ?? null,
      date_done: task.date_done ?? null,

      start_date: task.start_date ?? null,
      due_date: task.due_date ?? null,

      time_estimate: task.time_estimate ?? null,
      time_spent: task.time_spent ?? null,

      assignees: normalizeUsers(
        task.assignees
      ),

      watchers: normalizeUsers(
        task.watchers
      ),

      tags: normalizeTags(task.tags),

      custom_fields: normalizeCustomFields(
        task.custom_fields
      ),

      dependencies: normalizeDependencies(
        task.dependencies
      ),

      linked_tasks: normalizeLinkedTasks(
        task.linked_tasks
      ),

      checklists: normalizeChecklists(
        task.checklists
      ),

      attachments: normalizeAttachments(
        task.attachments
      ),

      source_url: task.url ?? null
    })
  );
}

function normalizeStatuses(statuses = []) {
  return [...statuses]
    .map(normalizeStatus)
    .sort(compareByOrderThenName);
}

function normalizeStatus(status) {
  return cleanUndefined({
    id: stringOrNull(status.id),
    name: status.status ?? status.name ?? null,
    type: status.type ?? null,
    color: status.color ?? null,
    order_index:
      status.orderindex ??
      status.order_index ??
      null
  });
}

function normalizePriority(priority) {
  return cleanUndefined({
    id: stringOrNull(priority.id),
    name:
      priority.priority ??
      priority.name ??
      null,

    color: priority.color ?? null,

    order_index:
      priority.orderindex ??
      priority.order_index ??
      null
  });
}

function normalizeUsers(users = []) {
  return [...users]
    .map(normalizeUser)
    .sort((a, b) =>
      String(a.id).localeCompare(String(b.id))
    );
}

function normalizeUser(user) {
  return cleanUndefined({
    id: stringOrNull(user.id),
    username: user.username ?? null,
    email: user.email ?? null,
    initials: user.initials ?? null,
    role: user.role ?? null
  });
}

function normalizeTags(tags = []) {
  return [...tags]
    .map(tag => cleanUndefined({
      name: tag.name ?? null,
      foreground_color:
        tag.tag_fg ?? null,
      background_color:
        tag.tag_bg ?? null
    }))
    .sort((a, b) =>
      String(a.name).localeCompare(
        String(b.name)
      )
    );
}

function normalizeCustomFields(fields = []) {
  return [...fields]
    .map(field => cleanUndefined({
      id: stringOrNull(field.id),
      name: field.name ?? null,
      type: field.type ?? null,
      type_config: field.type_config ?? null,
      value:
        field.value !== undefined
          ? field.value
          : null
    }))
    .sort((a, b) =>
      String(a.id).localeCompare(String(b.id))
    );
}

function normalizeDependencies(dependencies = []) {
  return [...dependencies]
    .map(dependency => cleanUndefined({
      task_id:
        stringOrNull(dependency.task_id),

      depends_on:
        stringOrNull(dependency.depends_on),

      type: dependency.type ?? null
    }))
    .sort(compareJsonValues);
}

function normalizeLinkedTasks(linkedTasks = []) {
  return [...linkedTasks]
    .map(link => cleanUndefined({
      task_id:
        stringOrNull(link.task_id),

      link_id:
        stringOrNull(link.link_id),

      date_created:
        link.date_created ?? null,

      userid:
        stringOrNull(link.userid)
    }))
    .sort(compareJsonValues);
}

function normalizeChecklists(checklists = []) {
  return [...checklists]
    .map(checklist => cleanUndefined({
      id: stringOrNull(checklist.id),
      name: checklist.name ?? null,
      order_index:
        checklist.orderindex ?? null,

      resolved: checklist.resolved ?? null,

      items: [...(checklist.items ?? [])]
        .map(item => cleanUndefined({
          id: stringOrNull(item.id),
          name: item.name ?? null,
          order_index:
            item.orderindex ?? null,
          resolved: item.resolved ?? null,
          parent: item.parent ?? null
        }))
        .sort(compareByOrderThenName)
    }))
    .sort(compareByOrderThenName);
}

function normalizeAttachments(attachments = []) {
  return [...attachments]
    .map(attachment => cleanUndefined({
      id: stringOrNull(attachment.id),
      title: attachment.title ?? null,
      date: attachment.date ?? null,
      type: attachment.type ?? null,
      extension: attachment.extension ?? null,
      url: attachment.url ?? null
    }))
    .sort((a, b) =>
      String(a.id).localeCompare(String(b.id))
    );
}

function getParentFolderId(folder) {
  const parent = folder.parent_folder;

  if (parent == null) {
    return null;
  }

  if (
    typeof parent === "string" ||
    typeof parent === "number"
  ) {
    return String(parent);
  }

  if (parent.id != null) {
    return String(parent.id);
  }

  return null;
}

function stringOrNull(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  return String(value);
}

function compareByOrderThenName(a, b) {
  const orderA = Number(
    a.order_index ?? Number.MAX_SAFE_INTEGER
  );

  const orderB = Number(
    b.order_index ?? Number.MAX_SAFE_INTEGER
  );

  if (orderA !== orderB) {
    return orderA - orderB;
  }

  return String(a.name ?? a.id).localeCompare(
    String(b.name ?? b.id)
  );
}

function compareJsonValues(a, b) {
  return JSON.stringify(a).localeCompare(
    JSON.stringify(b)
  );
}